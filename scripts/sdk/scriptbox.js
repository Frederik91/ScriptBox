// scriptbox.js
// Runs before every script. Turns the raw __host bridge from the WASM guest
// into console and __scriptbox.createMethod, then removes it from the global
// scope so user code only reaches the host through registered APIs.
//
// Both hosts load this file. The guest's bridge decides the mode:
// - ABI 1 (__host.call, the .NET host): a host call returns its value.
// - ABI 2 (__host.post, the Node host): a host call returns a promise that the
//   host settles later, values crossing the boundary must have an exact JSON
//   form, and the bootstrap installs its resume and encode hooks with the
//   guest, which keeps them out of the script's reach.
(function (root) {
  'use strict';

  // Bumped when the contract between this file and a host changes. A host
  // that passes `bootstrap` in the options refuses to run against another.
  var BOOTSTRAP_VERSION = 2;

  var host = root.__host;
  var options = root.__scriptbox_options || {};
  delete root.__host;
  delete root.__scriptbox_options;

  var isAsync = !!host && typeof host.post === 'function';
  if (!host || typeof host.log !== 'function'
      || (isAsync ? typeof host.install !== 'function' : typeof host.call !== 'function')) {
    throw new Error('The ScriptBox host bridge is missing.');
  }

  if (typeof options.bootstrap !== 'undefined' && options.bootstrap !== BOOTSTRAP_VERSION) {
    throw new Error('The host expects bootstrap version ' + options.bootstrap + ' but this is version ' + BOOTSTRAP_VERSION + '.');
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

  function hostError(error) {
    var result = new Error(error.message);
    result.name = error.name || 'HostError';
    return result;
  }

  // ---------- ABI 1: synchronous host calls ----------

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

  function callHostSync(method, args) {
    var response = JSON.parse(host.call(JSON.stringify({ method: method, args: toArgs(args || []) })));
    if (response.error) {
      throw hostError(response.error);
    }
    return options.sealResults ? deepSeal(response.result) : response.result;
  }

  // ---------- ABI 2: posted host calls ----------

  var MAX_DEPTH = typeof options.maxDepth === 'number' ? options.maxDepth : 64;

  // Taken before any script runs, so a script that replaces JSON, Object.keys,
  // Error or an Array method cannot change how its requests are written or its
  // responses read. The host validates every request either way.
  var uncurry = Function.prototype.bind.bind(Function.prototype.call);
  var stringify = JSON.stringify;
  var parse = JSON.parse;
  var keysOf = Object.keys;
  var protoOf = Object.getPrototypeOf;
  var seal = Object.seal;
  var isArray = Array.isArray;
  var objectProto = Object.prototype;
  var PromiseClass = Promise;
  var ErrorClass = Error;
  var TypeErrorClass = TypeError;
  var RangeErrorClass = RangeError;
  var push = uncurry(Array.prototype.push);
  var pop = uncurry(Array.prototype.pop);
  var join = uncurry(Array.prototype.join);
  var slice = uncurry(Array.prototype.slice);
  var matches = uncurry(RegExp.prototype.test);
  var identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  function typeName(value) {
    if (typeof value === 'number') {
      return value !== value ? 'NaN' : 'Infinity';
    }
    if (typeof value === 'bigint') {
      return 'a BigInt';
    }
    if (typeof value === 'undefined') {
      return 'undefined';
    }
    if (typeof value === 'function') {
      return 'a function';
    }
    if (typeof value === 'symbol') {
      return 'a symbol';
    }
    var proto = protoOf(value);
    var name = proto && proto.constructor && typeof proto.constructor.name === 'string' ? proto.constructor.name : '';
    return name ? 'a ' + name : 'an object with a custom prototype';
  }

  function unsupported(path, value) {
    return new TypeErrorClass(path + ' is ' + typeName(value) + ', which has no JSON form. '
      + 'Only strings, finite numbers, booleans, null, arrays and plain objects cross the boundary.');
  }

  function propertyPath(path, key) {
    return matches(identifier, key) ? path + '.' + key : path + '[' + stringify(key) + ']';
  }

  // JSON.stringify drops or coerces what it cannot represent: NaN becomes null,
  // a Map becomes {}, a function disappears. This encoder refuses instead and
  // names the path. A property whose value is undefined is left out, as an
  // omitted optional field.
  function encodeValue(value, path, depth, stack) {
    if (value === null) {
      return 'null';
    }
    switch (typeof value) {
      case 'string':
        return stringify(value);
      case 'boolean':
        return value ? 'true' : 'false';
      case 'number':
        if (value !== value || value === Infinity || value === -Infinity) {
          throw unsupported(path, value);
        }
        return stringify(value);
      case 'object':
        break;
      default:
        throw unsupported(path, value);
    }

    if (depth >= MAX_DEPTH) {
      throw new RangeErrorClass(path + ' is nested deeper than ' + MAX_DEPTH + ' levels.');
    }
    for (var s = 0; s < stack.length; s++) {
      if (stack[s] === value) {
        throw new TypeErrorClass(path + ' refers back to an object that contains it, which has no JSON form.');
      }
    }
    push(stack, value);

    var parts = [];
    var text;
    if (isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (!(i in value) || typeof value[i] === 'undefined') {
          throw new TypeErrorClass(path + '[' + i + '] is empty or undefined. Use null for a missing array element.');
        }
        push(parts, encodeValue(value[i], path + '[' + i + ']', depth + 1, stack));
      }
      text = '[' + join(parts, ',') + ']';
    } else {
      var proto = protoOf(value);
      if (proto !== objectProto && proto !== null) {
        throw unsupported(path, value);
      }
      var keys = keysOf(value);
      for (var k = 0; k < keys.length; k++) {
        var item = value[keys[k]];
        if (typeof item === 'undefined') {
          continue;
        }
        push(parts, stringify(keys[k]) + ':' + encodeValue(item, propertyPath(path, keys[k]), depth + 1, stack));
      }
      text = '{' + join(parts, ',') + '}';
    }

    pop(stack);
    return text;
  }

  // An undefined argument is omitted rather than sent as null, so the host can
  // tell "not given" from null and apply the parameter's default. Omitted
  // positions are listed; their array slots hold null.
  function encodeRequest(method, args) {
    var count = args.length;
    while (count > 0 && typeof args[count - 1] === 'undefined') {
      count--;
    }
    var parts = [];
    var omitted = [];
    for (var i = 0; i < count; i++) {
      if (typeof args[i] === 'undefined') {
        push(omitted, i);
        push(parts, 'null');
      } else {
        push(parts, encodeValue(args[i], method + ' argument ' + (i + 1), 1, []));
      }
    }
    return '{"method":' + stringify(method) + ',"args":[' + join(parts, ',') + ']'
      + (omitted.length ? ',"omitted":[' + join(omitted, ',') + ']' : '') + '}';
  }

  var pending = Object.create(null);

  // host.post returns the call's id, or a code for a call the host refused
  // before it started.
  function refusal(code, method) {
    switch (code) {
      case 0:
        return asyncHostError({ name: 'RevokedError', message: method + ' was not called: this execution no longer accepts host calls.' });
      case -1:
        return asyncHostError({ name: 'QueueFullError', message: method + ' was not called: too many host calls are waiting. Await earlier calls first.' });
      case -2:
        return asyncHostError({ name: 'RequestTooLargeError', message: method + ' was not called: its arguments are larger than one host call may carry.' });
      default:
        return asyncHostError({ name: 'HostError', message: method + ' was not called.' });
    }
  }

  function callHostAsync(method, args) {
    return new PromiseClass(function (resolve, reject) {
      if (typeof method !== 'string' || method.length === 0) {
        throw new TypeErrorClass('A host method name must be a non-empty string.');
      }
      var id = host.post(encodeRequest(method, args || []));
      if (id > 0) {
        pending[id] = { resolve: resolve, reject: reject };
      } else {
        reject(refusal(id, method));
      }
    });
  }

  function asyncHostError(error) {
    var result = new ErrorClass(error.message);
    result.name = error.name || 'HostError';
    return result;
  }

  function sealDeep(value) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        value[i] = sealDeep(value[i]);
      }
      return value;
    }
    var keys = keysOf(value);
    for (var k = 0; k < keys.length; k++) {
      value[keys[k]] = sealDeep(value[keys[k]]);
    }
    return seal(value);
  }

  function resume(text) {
    var response = parse(text);
    var entry = pending[response.id];
    if (!entry) {
      throw new ErrorClass('The host settled call ' + response.id + ', which is not waiting.');
    }
    delete pending[response.id];
    if (response.error) {
      entry.reject(asyncHostError(response.error));
    } else {
      entry.resolve(options.sealResults ? sealDeep(response.result) : response.result);
    }
  }

  function encodeResult(value) {
    return typeof value === 'undefined' ? undefined : encodeValue(value, 'The script\'s result', 0, []);
  }

  if (isAsync) {
    host.install({ protocol: 2, resume: resume, encode: encodeResult });
  }

  // ---------- Shared ----------

  var callHost = isAsync ? callHostAsync : callHostSync;

  function createMethod(methodName) {
    if (typeof methodName !== 'string' || methodName.length === 0) {
      throw new Error('Method name must be a non-empty string');
    }
    return function () {
      return callHost(methodName, slice(arguments));
    };
  }

  // The global and its functions cannot be replaced, so a script cannot change how other code reaches the
  // host. The object stays extensible for bootstrap helpers. Every call, through a namespace or hostCall, still
  // passes the host's filters.
  var api = {};
  Object.defineProperty(api, 'hostCall', { value: callHost, enumerable: true });
  Object.defineProperty(api, 'createMethod', { value: createMethod, enumerable: true });
  Object.defineProperty(api, 'version', { value: BOOTSTRAP_VERSION, enumerable: true });
  Object.defineProperty(root, '__scriptbox', { value: api, writable: false, enumerable: false, configurable: false });
})(globalThis);
