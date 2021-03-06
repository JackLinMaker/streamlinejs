// Copyright 2011 Marcel Laverdet
"use strict";
var Fiber = require('../util/require')('fibers', module.parent.filename);

/**
 * container for the context that the runtime maintains across async calls
 */
var globals = require('../globals');
globals.runtime = 'fibers';
var fut = require("streamline/lib/util/future");

this.create = create;
this.invoke = invoke;
this.construct = construct;
this.spin = spin;
this.streamlinify = fut.streamlinify;

/**
 * Creates a function that builds a fiber when called and automatically returns a future.
 *
 * rewrite:
 * function foo(arg, _) {
 *	 ...
 * }
 * ->
 * var foo = create(foo(arg, _) {
 *	 ...
 * }, 1);
 */

// special hack to preserve the arity in create.
// To avoid runtime overhead in the generated function, I generate a different creator function for each arity value
// This is the template for the create function.
// For each arity we will generate a variant of this function where F() is replaced by F(a1, a2, ...)
function createTemplate(fn, idx) {
	function F() {
		var cb = arguments[idx];
		if (!cb) return fut.future.call(this, F, arguments, idx);

		// Start a new fiber
		var that = this,
			args = arguments;
		Fiber(function() {
			var val;
			globals.emitter && globals.emitter.emit("resume");
			try {
				val = fn.apply(that, args);
			} catch (err) {
				return cb(err);
			} finally {
				globals.emitter && globals.emitter.emit("yield");
			}
			cb(null, val);
		}).run();
	};

	// Memoize the original function for fast passing later
	F.fstreamlineFunction = fn;
	return F;
}

var createBody = createTemplate.toString();
createBody = createBody.substring(createBody.indexOf('{'));

var creators = [];

function makeCreator(i) {
	function makeArgs(i) {
		if (i <= 0) throw new Error("bad arg count: " + i);
		return i > 1 ? makeArgs(i - 1) + ', a' + i : "a1";
	}
	return eval("(function(fn, idx)" + createBody.replace("F()", "F(" + makeArgs(i) + ")") + ")");
}

function create(fn, idx) {
	var i = fn.length;
	var creator = creators[i] || (creators[i] = makeCreator(i));
	return creator(fn, idx); 
}

/**
 * Invokes an async function and yields currently running fiber until it callsback.
 *
 * rewrite:
 * fs.readFile(file, _);
 * ->
 * invoke(fs, 'readFile', [file], 1);
 */

function invoke(that, fn, args, options) {
	var idx = (options && typeof options === 'object') ? options.callbackIndex : options; 
	// Resolve the function to be called
	if (typeof fn !== 'function') {
		if (typeof that === 'function' && that.fstreamlineFunction && fn === 'call') {
			return that.fstreamlineFunction.apply(args[0], args.slice(1));
		}
		fn = that[fn];
	}

	// If we're waiting on a fstreamline.create function we can just call it directly instead
	if (fn.fstreamlineFunction) {
		try {
			return fn.fstreamlineFunction.apply(that, args);
		} catch (e) {
			throw makeError(e, false);
		}
	}

	// Setup callback to resume fiber after it's yielded
	var fiber = Fiber.current;
	var err, val, yielded = false, cx;
	args[idx] = function(e, v) {
		if (options && options.returnArray) v = Array.prototype.slice.call(arguments, 1);
		if (!yielded) {
			yielded = true;
			err = e;
			val = v;
		} else {
			globals.context = cx;
			globals.emitter && globals.emitter.emit("resume");
			try {
				if (e) {
					fiber.throwInto(e);
				} else {
					fiber.run(v);
				}
			} finally {
				globals.emitter && globals.emitter.emit("yield");
			}
		}
	};

	// Invoke the function and yield
	fn.apply(that, args);
	if (yielded) {
		if (err) {
			throw makeError(err, true);
		}
		return val;
	}
	yielded = true;
	cx = globals.context;
	try {
		return Fiber.yield();
	} catch (e) {
		throw makeError(e, true);
	}
}

function construct(constructor, i) {
	var key = '__async' + i;
	return constructor[key] || (constructor[key] = function() {
		var that = Object.create(constructor.prototype);
		(constructor.fstreamlineFunction || constructor).apply(that, arguments);
		return that;
	});
}

function spin(fn, that, args, idx) {
	var fut = exports.create(fn, idx).apply(that, args);
	return function() {
		return exports.invoke(null, fut, arguments, 0);
	} 
}

// Double stack capture size because we may filter out half of them
Error.stackTraceLimit *= 2;

// Wraps an error to fix stacktrace

function makeError(e, incomplete) {
	if (!(e instanceof Error)) return e;
	var extra;
	if (incomplete) {
		extra = {};
		Error.captureStackTrace(extra);
	}
	var ne = Object.create(e);
	Object.defineProperty(ne, 'stack', {
		get: function() {
			return (e.stack + (extra ? extra.stack : "")).split('\n').filter(function(frame) {
				return frame.indexOf('streamline/lib/fibers/runtime.js') < 0 &&
					frame.indexOf('streamline/lib/util/future.js') < 0;
			}).join('\n');
		},
		enumerable: true,
	});
	return ne;
}
require("streamline/lib/fibers/builtins");
