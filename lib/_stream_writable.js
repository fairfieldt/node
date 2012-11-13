// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// A bit simpler than readable streams.
// Implement an async ._write(chunk, cb), and it'll handle all
// the drain event emission and buffering.

module.exports = Writable;
Writable.WritableState = WritableState;

var util = require('util');
var Stream = require('stream');

util.inherits(Writable, Stream);

function WritableState(options) {
  options = options || {};
  this.highWaterMark = options.highWaterMark || 16 * 1024;
  this.highWaterMark = options.hasOwnProperty('highWaterMark') ?
      options.highWaterMark : 16 * 1024;
  this.lowWaterMark = options.hasOwnProperty('lowWaterMark') ?
      options.lowWaterMark : 1024;
  this.needDrain = false;
  this.ended = false;
  this.ending = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  this.decodeStrings = options.hasOwnProperty('decodeStrings') ?
      options.decodeStrings : true;

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  this.writing = false;
  this.buffer = [];
}

function Writable(options) {
  // Writable ctor is applied to Duplexes, though they're not
  // instanceof Writable, they're instanceof Readable.
  if (!(this instanceof Writable) && !(this instanceof Stream.Duplex))
    return new Writable(options);

  this._writableState = new WritableState(options);

  // legacy.
  this.writable = true;

  Stream.call(this);
}

// Override this method for sync streams
// override the _write(chunk, cb) method for async streams
Writable.prototype.write = function(chunk, encoding, cb) {
  var state = this._writableState;
  if (state.ended) {
    this.emit('error', new Error('write after end'));
    return;
  }

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  var l = chunk.length;
  if (false === state.decodeStrings)
    chunk = [chunk, encoding];
  else if (typeof chunk === 'string' || encoding) {
    chunk = new Buffer(chunk + '', encoding);
    l = chunk.length;
  }

  state.length += l;

  var ret = state.length < state.highWaterMark;
  if (ret === false)
    state.needDrain = true;

  // if we're already writing something, then just put this
  // in the queue, and wait our turn.
  if (state.writing) {
    state.buffer.push([chunk, cb]);
    return ret;
  }

  state.writing = true;
  var sync = true;
  this._write(chunk, writecb.bind(this));
  sync = false;

  return ret;

  function writecb(er) {
    state.writing = false;
    if (er) {
      if (cb) {
        if (sync)
          process.nextTick(cb.bind(null, er));
        else
          cb(er);
      } else
        this.emit('error', er);
      return;
    }
    state.length -= l;

    if (cb) {
      // don't call the cb until the next tick if we're in sync mode.
      // also, defer if we're about to write some more right now.
      if (sync || state.buffer.length)
        process.nextTick(cb);
      else
        cb();
    }

    if (state.length === 0 && (state.ended || state.ending)) {
      // emit 'finish' at the very end.
      this.emit('finish');
      return;
    }

    // if there's something in the buffer waiting, then do that, too.
    if (state.buffer.length) {
      var chunkCb = state.buffer.shift();
      chunk = chunkCb[0];
      cb = chunkCb[1];

      if (false === state.decodeStrings)
        l = chunk[0].length;
      else
        l = chunk.length;

      state.writing = true;
      this._write(chunk, writecb.bind(this));
    }

    if (state.length <= state.lowWaterMark && state.needDrain) {
      // Must force callback to be called on nextTick, so that we don't
      // emit 'drain' before the write() consumer gets the 'false' return
      // value, and has a chance to attach a 'drain' listener.
      process.nextTick(function() {
        if (!state.needDrain)
          return;
        state.needDrain = false;
        this.emit('drain');
      }.bind(this));
    }
  }

};

Writable.prototype._write = function(chunk, cb) {
  process.nextTick(cb.bind(this, new Error('not implemented')));
};

Writable.prototype.end = function(chunk, encoding) {
  var state = this._writableState;
  state.ending = true;
  if (chunk)
    this.write(chunk, encoding);
  else if (state.length === 0)
    this.emit('finish');
  state.ended = true;
};