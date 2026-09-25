// scriptbox.js
// Runs before every script. Turns the raw __host bridge from the WASM guest
// into console and __scriptbox.createMethod, then removes it from the global
// scope so user code only reaches the host through registered APIs.
(function (root) {
  'use strict';

  var host = root.__host;
  var options = root.__scriptbox_options || {};
  delete root.__host;
  delete root.__scriptbox_options;

  if (!host || typeof host.call !== 'function' || typeof host.log !== 'function') {
    throw new Error('The ScriptBox host bridge is missing.');
  }

  function describe(value) {
    if (typeof value === 'string') {
      return value;
    }
    if (value instanceof Error) {
      return value.name + ': ' + value.message + (value.stack ? '\n' + value.stack : '');
    }
    if (typeof value === 'function') {
      return '[Function ' + (value.name || 'anonymous') + ']';
    }
    if (typeof value === 'undefined') {
      return 'undefined';
    }
    try {
      var json = JSON.stringify(value);
      return typeof json === 'undefined' ? String(value) : json;
    } catch (e) {
      return String(value);
    }
  }

  function logger(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        parts.push(describe(arguments[i]));
      }
      host.log(level, parts.join(' '));
    };
  }

  root.console = Object.freeze({
    log: logger(0),
    debug: logger(0),
    info: logger(1),
    warn: logger(2),
    error: logger(3)
  });

  // Arrays are left growable so a script can still push to a list it read.
  function deepSeal(value) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        value[i] = deepSeal(value[i]);
      }
      return value;
    }
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        value[key] = deepSeal(value[key]);
      }
    }
    return Object.seal(value);
  }

  // Trailing undefined arguments are dropped so the host can apply its
  // parameter defaults; any other undefined becomes null, as JSON would.
  function toArgs(args) {
    var count = args.length;
    while (count > 0 && typeof args[count - 1] === 'undefined') {
      count--;
    }
    var list = new Array(count);
    for (var i = 0; i < count; i++) {
      list[i] = typeof args[i] === 'undefined' ? null : args[i];
    }
    return list;
  }

  function callHost(method, args) {
    var response = JSON.parse(host.call(JSON.stringify({ method: method, args: toArgs(args || []) })));
    if (response.error) {
      var error = new Error(response.error.message);
      error.name = response.error.name || 'HostError';
      throw error;
    }
    return options.sealResults ? deepSeal(response.result) : response.result;
  }

  function createMethod(methodName) {
    if (typeof methodName !== 'string' || methodName.length === 0) {
      throw new Error('Method name must be a non-empty string');
    }
    return function () {
      return callHost(methodName, arguments);
    };
  }

  root.__scriptbox = {
    hostCall: callHost,
    createMethod: createMethod
  };
})(globalThis);
