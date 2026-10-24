#include "quickjs.h"
#include <stdlib.h>
#include <string.h>
#include <malloc.h>

// ============================================================================
// ScriptBox guest: QuickJS behind a small host ABI with no size limits.
//
// This file builds scriptbox-async.wasm (see build.sh), which both the .NET
// and the Node host run. sb_abi_version() reports ABI 2: a host call is posted
// and the guest returns to the host, which settles it later through
// sb_resume. Memory is imported so the host sets its maximum, and a failed
// allocation traps.
//
// One WASM instance serves one execution. The host calls, in order:
//   sb_init()                          create the runtime and install the bridge
//   sb_alloc(n) + sb_eval(..., 0)      evaluate each bootstrap script
//   sb_alloc(n) + sb_eval(..., 2)      start the user script; then
//   sb_alloc(n) + sb_resume(...)       settle one posted call, as often as needed
//   sb_finish()                        report a rejection nothing handled
//
// Nothing crosses the boundary through a fixed buffer. Payloads going to the
// host are passed as (ptr, len) into guest memory. The host allocates with
// sb_alloc and passes the buffer to sb_resume, which frees it.
// ============================================================================

#define SB_ABI_VERSION 2

// Admits one host call and returns its id, or 0 when the execution no longer
// admits calls. The host traps instead of returning when a hard limit is hit.
__attribute__((import_module("host"), import_name("post")))
int host_post(const char* in_ptr, int in_len);

// Never returns: the host traps the instance. kind is one of SB_LIMIT_*.
__attribute__((import_module("host"), import_name("limit")))
void host_limit(int kind);

#define SB_LIMIT_MEMORY 1

__attribute__((import_module("host"), import_name("log")))
void host_log(int level, const char* ptr, int len);

__attribute__((import_module("host"), import_name("interrupt")))
int host_interrupt(void);

__attribute__((import_module("host"), import_name("result")))
void host_result(const char* ptr, int len);

__attribute__((import_module("host"), import_name("error")))
void host_error(const char* name_ptr, int name_len,
                const char* message_ptr, int message_len,
                const char* stack_ptr, int stack_len);

#define SB_OK 0
#define SB_SCRIPT_ERROR 1   // details were sent through host.error
#define SB_NOT_INITIALIZED 2
#define SB_OUT_OF_MEMORY 3
#define SB_PENDING 4        // the script awaits a posted call
#define SB_UNHANDLED_REJECTION 5 // details were sent through host.error
#define SB_PROTOCOL_ERROR 6 // details were sent through host.error
#define SB_SYNTAX_ERROR 7   // the user script did not compile; details were sent through host.error

// QuickJS measures recursion on the shadow stack in linear memory (8 MB, set
// in build.sh), but each JS frame also uses several times as much of the
// native stack the engine runs on, which it cannot see. 1 MB keeps QuickJS's
// catchable "stack overflow" error ahead of the native limit (WasmRuntime.MaxWasmStackSize
// in .NET, the worker's stack size in Node).
#define SB_JS_STACK_SIZE (1024 * 1024)

static JSRuntime* g_rt = NULL;
static JSContext* g_ctx = NULL;

__attribute__((export_name("sb_abi_version")))
int sb_abi_version(void) {
    return SB_ABI_VERSION;
}

__attribute__((export_name("sb_alloc")))
void* sb_alloc(int size) {
    return malloc(size > 0 ? (size_t)size : 1);
}

__attribute__((export_name("sb_free")))
void sb_free(void* ptr) {
    free(ptr);
}

// ---------- Error reporting ----------

static void report_c_error(const char* name, const char* message) {
    host_error(name, (int)strlen(name), message, (int)strlen(message), "", 0);
}

static const char* get_string_property(JSContext* ctx, JSValueConst obj, const char* prop, size_t* len) {
    JSValue value = JS_GetPropertyStr(ctx, obj, prop);
    const char* str = NULL;
    if (!JS_IsUndefined(value) && !JS_IsNull(value)) {
        str = JS_ToCStringLen(ctx, len, value);
    }
    JS_FreeValue(ctx, value);
    return str;
}

// An Error contributes its name, message and stack. Any other thrown value
// (`throw "text"`) is reported by its string form as the message.
static void report_exception(JSContext* ctx, JSValueConst exc) {
    size_t name_len = 0, message_len = 0, stack_len = 0;
    const char* name = NULL;
    const char* message = NULL;
    const char* stack = NULL;

    if (JS_IsError(ctx, exc)) {
        name = get_string_property(ctx, exc, "name", &name_len);
        message = get_string_property(ctx, exc, "message", &message_len);
        stack = get_string_property(ctx, exc, "stack", &stack_len);
    } else {
        message = JS_ToCStringLen(ctx, &message_len, exc);
    }

    host_error(name ? name : "", (int)name_len,
               message ? message : "", (int)message_len,
               stack ? stack : "", (int)stack_len);

    if (name) JS_FreeCString(ctx, name);
    if (message) JS_FreeCString(ctx, message);
    if (stack) JS_FreeCString(ctx, stack);
}

static void report_pending_exception(JSContext* ctx) {
    JSValue exc = JS_GetException(ctx);
    report_exception(ctx, exc);
    JS_FreeValue(ctx, exc);
}

// ---------- Bridge functions, exposed to JavaScript as __host.* ----------

// __host.log(level: number, message: string): void
static JSValue js_host_log(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    int level = 0;
    if (argc < 2 || JS_ToInt32(ctx, &level, argv[0]) != 0) {
        return JS_ThrowTypeError(ctx, "__host.log requires a level and a message");
    }

    size_t len;
    const char* message = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!message) {
        return JS_EXCEPTION;
    }

    host_log(level, message, (int)len);
    JS_FreeCString(ctx, message);
    return JS_UNDEFINED;
}

// The bootstrap's hooks, installed once through __host.install. Only C holds
// them, so a user script cannot reach or replace them.
static JSValue g_resume = JS_UNDEFINED;
static JSValue g_encode = JS_UNDEFINED;
static int g_installed = 0;

// The user script's promise, once sb_eval(..., 2) has started it.
static JSValue g_main = JS_UNDEFINED;
static int g_main_started = 0;
static int g_main_reported = 0;

// Rejected promises that nothing has handled yet. The tracker adds a promise
// when it is rejected without a handler and removes it when one is attached.
#define SB_MAX_UNHANDLED 64
static JSValue g_unhandled_promise[SB_MAX_UNHANDLED];
static JSValue g_unhandled_reason[SB_MAX_UNHANDLED];
static int g_unhandled_count = 0;
static int g_unhandled_overflow = 0;

static void track_rejection(JSContext* ctx, JSValueConst promise, JSValueConst reason, JS_BOOL is_handled, void* opaque) {
    if (!is_handled) {
        if (g_unhandled_count < SB_MAX_UNHANDLED) {
            g_unhandled_promise[g_unhandled_count] = JS_DupValue(ctx, promise);
            g_unhandled_reason[g_unhandled_count] = JS_DupValue(ctx, reason);
            g_unhandled_count++;
        } else {
            g_unhandled_overflow = 1;
        }
        return;
    }

    for (int i = 0; i < g_unhandled_count; i++) {
        if (JS_VALUE_GET_PTR(g_unhandled_promise[i]) == JS_VALUE_GET_PTR(promise)) {
            JS_FreeValue(ctx, g_unhandled_promise[i]);
            JS_FreeValue(ctx, g_unhandled_reason[i]);
            g_unhandled_count--;
            g_unhandled_promise[i] = g_unhandled_promise[g_unhandled_count];
            g_unhandled_reason[i] = g_unhandled_reason[g_unhandled_count];
            return;
        }
    }
}

// __host.post(payload: string): number
static JSValue js_host_post(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "__host.post requires a JSON string");
    }

    size_t payload_len;
    const char* payload = JS_ToCStringLen(ctx, &payload_len, argv[0]);
    if (!payload) {
        return JS_EXCEPTION;
    }

    int id = host_post(payload, (int)payload_len);
    JS_FreeCString(ctx, payload);
    return JS_NewInt32(ctx, id);
}

// __host.install({ protocol, resume, encode }): void
//
// resume(response: string) settles one posted call. encode(value) returns the
// script's result as JSON text, or undefined for no value, and throws for a
// value that has no JSON form.
static JSValue js_host_install(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (g_installed) {
        return JS_ThrowTypeError(ctx, "The ScriptBox bridge is already installed");
    }
    if (argc < 1 || !JS_IsObject(argv[0])) {
        return JS_ThrowTypeError(ctx, "__host.install requires a hooks object");
    }

    int32_t protocol = 0;
    JSValue protocol_value = JS_GetPropertyStr(ctx, argv[0], "protocol");
    int converted = JS_ToInt32(ctx, &protocol, protocol_value);
    JS_FreeValue(ctx, protocol_value);
    if (converted != 0) {
        return JS_EXCEPTION;
    }
    if (protocol != SB_ABI_VERSION) {
        return JS_ThrowTypeError(ctx, "The bootstrap speaks protocol %d but the guest speaks protocol %d", protocol, SB_ABI_VERSION);
    }

    JSValue resume = JS_GetPropertyStr(ctx, argv[0], "resume");
    JSValue encode = JS_GetPropertyStr(ctx, argv[0], "encode");
    if (!JS_IsFunction(ctx, resume) || !JS_IsFunction(ctx, encode)) {
        JS_FreeValue(ctx, resume);
        JS_FreeValue(ctx, encode);
        return JS_ThrowTypeError(ctx, "__host.install requires resume and encode functions");
    }

    g_resume = resume;
    g_encode = encode;
    g_installed = 1;
    return JS_UNDEFINED;
}

// The allocator QuickJS uses, with the accounting of QuickJS's own default
// allocator. A failed allocation means the host's memory maximum was reached,
// so it traps through host.limit instead of becoming an "out of memory" error
// that a script could catch and carry on from.
#define SB_MALLOC_OVERHEAD 8

static void* sb_js_malloc(JSMallocState* s, size_t size) {
    void* ptr = malloc(size);
    if (!ptr) {
        host_limit(SB_LIMIT_MEMORY);
        return NULL;
    }
    s->malloc_count++;
    s->malloc_size += malloc_usable_size(ptr) + SB_MALLOC_OVERHEAD;
    return ptr;
}

static void sb_js_free(JSMallocState* s, void* ptr) {
    if (!ptr) {
        return;
    }
    s->malloc_count--;
    s->malloc_size -= malloc_usable_size(ptr) + SB_MALLOC_OVERHEAD;
    free(ptr);
}

static void* sb_js_realloc(JSMallocState* s, void* ptr, size_t size) {
    if (!ptr) {
        return size == 0 ? NULL : sb_js_malloc(s, size);
    }

    size_t old_size = malloc_usable_size(ptr);
    if (size == 0) {
        s->malloc_count--;
        s->malloc_size -= old_size + SB_MALLOC_OVERHEAD;
        free(ptr);
        return NULL;
    }

    void* resized = realloc(ptr, size);
    if (!resized) {
        host_limit(SB_LIMIT_MEMORY);
        return NULL;
    }
    s->malloc_size += malloc_usable_size(resized) - old_size;
    return resized;
}

static size_t sb_js_malloc_usable_size(const void* ptr) {
    return malloc_usable_size((void*)ptr);
}

static const JSMallocFunctions sb_malloc_functions = {
    sb_js_malloc,
    sb_js_free,
    sb_js_realloc,
    sb_js_malloc_usable_size,
};

static int install_bridge(JSContext* ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue host = JS_NewObject(ctx);
    if (JS_IsException(host)) {
        JS_FreeValue(ctx, global);
        return -1;
    }

    JS_SetPropertyStr(ctx, host, "post", JS_NewCFunction(ctx, js_host_post, "post", 1));
    JS_SetPropertyStr(ctx, host, "install", JS_NewCFunction(ctx, js_host_install, "install", 1));
    JS_SetPropertyStr(ctx, host, "log", JS_NewCFunction(ctx, js_host_log, "log", 2));
    JS_SetPropertyStr(ctx, global, "__host", host);
    JS_FreeValue(ctx, global);
    return 0;
}

// QuickJS polls this while running bytecode. The host stops a script by
// throwing from host.interrupt, which traps the instance. It never returns
// non-zero: QuickJS's own "interrupted" error becomes an ordinary rejection
// inside an async function, which a script could catch and carry on from.
static int interrupt_handler(JSRuntime* rt, void* opaque) {
    return host_interrupt();
}

// ---------- Exports ----------

__attribute__((export_name("sb_init")))
int sb_init(void) {
    if (g_ctx) {
        return SB_OK;
    }

    g_rt = JS_NewRuntime2(&sb_malloc_functions, NULL);
    if (!g_rt) {
        report_c_error("InternalError", "Failed to create the JavaScript runtime");
        return SB_OUT_OF_MEMORY;
    }

    JS_SetMaxStackSize(g_rt, SB_JS_STACK_SIZE);
    JS_SetInterruptHandler(g_rt, interrupt_handler, NULL);
    JS_SetHostPromiseRejectionTracker(g_rt, track_rejection, NULL);

    g_ctx = JS_NewContext(g_rt);
    if (!g_ctx) {
        report_c_error("InternalError", "Failed to create the JavaScript context");
        JS_FreeRuntime(g_rt);
        g_rt = NULL;
        return SB_OUT_OF_MEMORY;
    }

    if (install_bridge(g_ctx) != 0) {
        report_c_error("InternalError", "Failed to install the host bridge");
        return SB_OUT_OF_MEMORY;
    }

    return SB_OK;
}

// Runs queued promise jobs until none are left. Returns 0, or -1 after
// reporting an exception thrown by a job.
static int drain_jobs(void) {
    JSContext* job_ctx;
    for (;;) {
        int status = JS_ExecutePendingJob(g_rt, &job_ctx);
        if (status == 0) {
            return 0;
        }
        if (status < 0) {
            report_pending_exception(job_ctx);
            return -1;
        }
    }
}

// Encodes a settled result with the bootstrap's encoder, which rejects values
// that have no JSON form instead of dropping or coercing them.
static int report_encoded_value(JSValueConst value) {
    JSValue json = JS_Call(g_ctx, g_encode, JS_UNDEFINED, 1, (JSValueConst*)&value);
    if (JS_IsException(json)) {
        report_pending_exception(g_ctx);
        return SB_SCRIPT_ERROR;
    }

    if (JS_IsUndefined(json)) {
        host_result("", 0);
        return SB_OK;
    }

    size_t len;
    const char* str = JS_ToCStringLen(g_ctx, &len, json);
    JS_FreeValue(g_ctx, json);
    if (!str) {
        report_pending_exception(g_ctx);
        return SB_SCRIPT_ERROR;
    }

    host_result(str, (int)len);
    JS_FreeCString(g_ctx, str);
    return SB_OK;
}

// Reports the user script's outcome once its promise has settled.
static int check_main(void) {
    switch ((int)JS_PromiseState(g_ctx, g_main)) {
        case JS_PROMISE_PENDING:
            return SB_PENDING;
        case JS_PROMISE_FULFILLED: {
            g_main_reported = 1;
            JSValue settled = JS_PromiseResult(g_ctx, g_main);
            int status = report_encoded_value(settled);
            JS_FreeValue(g_ctx, settled);
            return status;
        }
        case JS_PROMISE_REJECTED: {
            g_main_reported = 1;
            JSValue reason = JS_PromiseResult(g_ctx, g_main);
            report_exception(g_ctx, reason);
            JS_FreeValue(g_ctx, reason);
            return SB_SCRIPT_ERROR;
        }
        default:
            g_main_reported = 1;
            return report_encoded_value(g_main);
    }
}

// Evaluates a script the host wrote into a buffer from sb_alloc, and frees
// that buffer.
//
// With mode = 0 the value is discarded (bootstrap scripts). With mode = 2 the
// user script is started: once the job queue is empty it returns SB_PENDING
// while the script awaits a posted call, or reports the outcome: a fulfilled
// value to host.result, a rejection or a thrown error to host.error. The host
// wraps the user script in an async function, so evaluating it fails only when
// the source does not compile, which returns SB_SYNTAX_ERROR. Other modes are
// refused.
__attribute__((export_name("sb_eval")))
int sb_eval(char* code, int code_len, const char* name, int name_len, int mode) {
    if (!g_ctx) {
        free(code);
        return SB_NOT_INITIALIZED;
    }

    if ((mode != 0 && mode != 2) || (mode == 2 && (!g_installed || g_main_started))) {
        free(code);
        report_c_error("InternalError", "This guest runs scripts with sb_eval mode 2 once, after the bootstrap installed the bridge.");
        return SB_PROTOCOL_ERROR;
    }

    char filename[128];
    int copy_len = name_len < (int)sizeof(filename) - 1 ? name_len : (int)sizeof(filename) - 1;
    memcpy(filename, name, (size_t)copy_len);
    filename[copy_len] = '\0';

    // JS_Eval reads a terminating NUL one past the end of the source.
    char* source = realloc(code, (size_t)code_len + 1);
    if (!source) {
        free(code);
        report_c_error("InternalError", "Out of memory while loading the script");
        return SB_OUT_OF_MEMORY;
    }
    source[code_len] = '\0';

    JSValue value = JS_Eval(g_ctx, source, (size_t)code_len, filename, JS_EVAL_TYPE_GLOBAL);
    free(source);

    if (JS_IsException(value)) {
        report_pending_exception(g_ctx);
        return mode == 2 ? SB_SYNTAX_ERROR : SB_SCRIPT_ERROR;
    }

    if (mode == 2) {
        g_main = value;
        g_main_started = 1;
        if (drain_jobs() != 0) {
            return SB_SCRIPT_ERROR;
        }
        return check_main();
    }

    JS_FreeValue(g_ctx, value);
    return drain_jobs() != 0 ? SB_SCRIPT_ERROR : SB_OK;
}

// Settles one posted call with the host's response, written into a buffer from
// sb_alloc, and frees that buffer. Runs the jobs the response unblocks, then
// returns as sb_eval mode 2 does. Once the outcome has been reported, later
// responses (for calls the script did not await) only run their jobs and
// return SB_OK.
__attribute__((export_name("sb_resume")))
int sb_resume(char* payload, int payload_len) {
    if (!g_ctx || !g_main_started) {
        free(payload);
        report_c_error("InternalError", "sb_resume was called before the script started.");
        return SB_PROTOCOL_ERROR;
    }

    JSValue response = JS_NewStringLen(g_ctx, payload, (size_t)payload_len);
    free(payload);
    if (JS_IsException(response)) {
        report_pending_exception(g_ctx);
        return SB_PROTOCOL_ERROR;
    }

    JSValue returned = JS_Call(g_ctx, g_resume, JS_UNDEFINED, 1, (JSValueConst*)&response);
    JS_FreeValue(g_ctx, response);
    if (JS_IsException(returned)) {
        report_pending_exception(g_ctx);
        return SB_PROTOCOL_ERROR;
    }
    JS_FreeValue(g_ctx, returned);

    if (drain_jobs() != 0) {
        return SB_SCRIPT_ERROR;
    }

    return g_main_reported ? SB_OK : check_main();
}

// Called once every posted call has settled. Reports the first rejection that
// nothing handled, other than the script's own, which sb_eval or sb_resume
// already reported.
__attribute__((export_name("sb_finish")))
int sb_finish(void) {
    if (!g_ctx || !g_main_started) {
        report_c_error("InternalError", "sb_finish was called before the script started.");
        return SB_PROTOCOL_ERROR;
    }

    for (int i = 0; i < g_unhandled_count; i++) {
        if (JS_VALUE_GET_PTR(g_unhandled_promise[i]) != JS_VALUE_GET_PTR(g_main)) {
            report_exception(g_ctx, g_unhandled_reason[i]);
            return SB_UNHANDLED_REJECTION;
        }
    }

    if (g_unhandled_overflow) {
        report_c_error("Error", "More promises were rejected without a handler than the guest could track.");
        return SB_UNHANDLED_REJECTION;
    }

    return SB_OK;
}
