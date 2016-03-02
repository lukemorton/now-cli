import getFiles from './get-files';
import hash from './hash';
import retry from './retry';
import Agent from './agent';
import EventEmitter from 'events';
import { resolve } from 'path';
import { stat, readFile } from 'fs-promise';

export default class Now extends EventEmitter {
  constructor (token, { forceNew = false, debug = false }) {
    super();
    this._token = token;
    this._debug = debug;
    this._forceNew = forceNew;
    this._agent = new Agent('api.now.sh', { debug });
    this._onRetry = this._onRetry.bind(this);
  }

  async create (path, { forceNew }) {
    this._path = path;

    try {
      await stat(path);
    } catch (err) {
      throw new Error(`Could not read directory ${path}.`);
    }

    let pkg;
    try {
      pkg = await readFile(resolve(path, 'package.json'));
      pkg = JSON.parse(pkg);
    } catch (err) {
      throw new Error(`Failed to read JSON in "${path}/package.json"`);
    }

    if (this._debug) console.time('> [debug] Getting files');
    const files = await getFiles(path, pkg);
    if (this._debug) console.timeEnd('> [debug] Getting files');

    if (this._debug) console.time('> [debug] Computing hashes');
    const hashes = await hash(files);
    if (this._debug) console.timeEnd('> [debug] Computing hashes');

    this._files = hashes;

    const deployment = await retry(async (bail) => {
      const res = await this._fetch('/create', {
        method: 'POST',
        body: {
          forceNew,
          files: Array.from(this._files).map(([sha, { data }]) => {
            return {
              sha,
              size: Buffer.byteLength(data)
            };
          })
        }
      });

      // no retry on 403
      if (403 === res.status) {
        if (this._debug) {
          console.log('> [debug] bailing on creating due to 403');
        }
        return bail(responseError(res));
      }

      if (200 !== res.status) {
        throw new Error('Deployment initialization failed');
      }

      return res.json();
    }, { retries: 3, minTimeout: 2500, onRetry: this._onRetry });

    this._id = deployment.deploymentId;
    this._url = deployment.url;
    this._missing = deployment.missing || [];

    return this._url;
  }

  upload () {
    Promise.all(this._missing.map((sha) => retry(async (bail) => {
      const file = this._files.get(sha);
      const { data, name } = file;
      const res = await this._fetch('/sync', {
        method: 'POST',
        body: {
          sha,
          data: data.toString(),
          file: toRelative(name, this._path),
          deploymentId: this._id
        }
      });

      // no retry on 403
      if (403 === res.status) {
        if (this._debug) console.log('> [debug] bailing on creating due to 403');
        return bail(responseError(res));
      }

      this.emit('upload', file);
    }, { retries: 5, randomize: true, onRetry: this._onRetry })))
    .then(() => this.emit('complete'))
    .catch((err) => this.emit('error', err));
  }

  _onRetry (err) {
    if (this._debug) {
      console.log(`> [debug] Retrying: ${err.stack}`);
    }
  }

  close () {
    this._agent.close();
  }

  get url () {
    return this._url;
  }

  get syncAmount () {
    if (!this._syncAmount) {
      this._syncAmount = this._missing
      .map((sha) => Buffer.byteLength(this._files.get(sha).data))
      .reduce((a, b) => a + b, 0);
    }
    return this._syncAmount;
  }

  async _fetch (url, opts) {
    opts.headers = opts.headers || {};
    opts.headers.authorization = `Bearer ${this._token}`;
    return await this._agent.fetch(url, opts);
  }
}

function toRelative (path, base) {
  const fullBase = /\/$/.test(base) ? base + '/' : base;
  return path.substr(fullBase.length);
}

function responseError (res) {
  const err = new Error('Response error');
  err.status = res.status;
  return err;
}