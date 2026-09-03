'use strict';
/* Minimal keyed async mutex: serializes async critical sections per key
 * (used to keep append-message + order.json updates atomic per conversation). */
class KeyedMutex {
  constructor() {
    this._tail = new Map(); // key -> promise resolving when the queue drains
  }
  async run(key, fn) {
    const prev = this._tail.get(key) || Promise.resolve();
    let done;
    const mine = new Promise((res) => (done = res));
    this._tail.set(key, mine);
    try {
      await prev;
      return await fn();
    } finally {
      done();
      if (this._tail.get(key) === mine) this._tail.delete(key);
    }
  }
}
module.exports = { KeyedMutex };
