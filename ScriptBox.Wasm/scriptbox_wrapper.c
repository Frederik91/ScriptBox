#include "quickjs.h"
#include <stdlib.h>
#include <string.h>

// ============================================================================
// ScriptBox guest: QuickJS behind a small host ABI with no size limits.
//
// One WASM instance serves one execution. The host calls, in order:
//   sb_init()                          create the runtime and install the bridge
//   sb_alloc(n) + sb_eval(..., 0)      evaluate each bootstrap script
//   sb_alloc(n) + sb_eval(..., 1)      evaluate the user script and report it
//
// Nothing crosses the boundary through a fixed buffer. Payloads going to the
// host are passed as (ptr, len) into guest memory. A host response is fetched
// in two steps because only the host knows its length: host.call returns the
// length, the guest allocates that much, and host.take copies it in.
// ============================================================================

__attribute__((import_module("host"), import_name("call")))
int host_call(const char* in_ptr, int in_len);

__attribute__((import_module("host"), import_name("take")))
void host_take(char* out_ptr, int out_len);

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

// QuickJS measures recursion on the shadow stack in linear memory (8 MB, set
// in build.sh), but each JS frame also uses several times as much of the
// native stack Wasmtime runs on, which it cannot see. 1 MB keeps QuickJS's
// catchable "stack overflow" error ahead of the native limit (WasmRuntime.MaxWasmStackSize).
#define SB_JS_STACK_SIZE (1024 * 1024)

static JSRuntime* g_rt = NULL;
static JSContext* g_ctx = NULL;

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

// __host.call(payload: string): string
static JSValue js_host_call(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "__host.call requires a JSON string");
    }

    size_t payload_len;
    const char* payload = JS_ToCStringLen(ctx, &payload_len, argv[0]);
    if (!payload) {
        return JS_EXCEPTION;
    }

    int response_len = host_call(payload, (int)payload_len);
    JS_FreeCString(ctx, payload);

    if (response_len < 0) {
        return JS_ThrowInternalError(ctx, "Host call failed");
    }

    char* response = malloc((size_t)response_len + 1);
    if (!response) {
        return JS_ThrowOutOfMemory(ctx);
    }

    host_take(response, response_len);
    JSValue result = JS_NewStringLen(ctx, response, (size_t)response_len);
    free(response);
    return result;
}

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

static int install_bridge(JSContext* ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue host = JS_NewObject(ctx);
    if (JS_IsException(host)) {
        JS_FreeValue(ctx, global);
        return -1;
    }

    JS_SetPropertyStr(ctx, host, "call", JS_NewCFunction(ctx, js_host_call, "call", 1));
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

    g_rt = JS_NewRuntime();
    if (!g_rt) {
        report_c_error("InternalError", "Failed to create the JavaScript runtime");
        return SB_OUT_OF_MEMORY;
    }

    JS_SetMaxStackSize(g_rt, SB_JS_STACK_SIZE);
    JS_SetInterruptHandler(g_rt, interrupt_handler, NULL);

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

// undefined, functions and symbols have no JSON form; they are reported as an
// empty result, which the host reads as "no value".
static int report_value(JSValueConst value) {
    JSValue json = JS_JSONStringify(g_ctx, value, JS_UNDEFINED, JS_UNDEFINED);
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

// Evaluates a script the host wrote into a buffer from sb_alloc, and frees
// that buffer.
//
// With report_result = 0 the value is discarded (bootstrap scripts). With
// report_result = 1 the value is the execution's outcome: a promise is settled
// by running the job queue, then a fulfilled value goes to host.result and a
// rejection or a thrown error goes to host.error.
__attribute__((export_name("sb_eval")))
int sb_eval(char* code, int code_len, const char* name, int name_len, int report_result) {
    if (!g_ctx) {
        free(code);
        return SB_NOT_INITIALIZED;
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
        return SB_SCRIPT_ERROR;
    }

    if (drain_jobs() != 0) {
        JS_FreeValue(g_ctx, value);
        return SB_SCRIPT_ERROR;
    }

    if (!report_result) {
        JS_FreeValue(g_ctx, value);
        return SB_OK;
    }

    int status;
    switch ((int)JS_PromiseState(g_ctx, value)) {
        case -1:
            status = report_value(value);
            break;
        case JS_PROMISE_FULFILLED: {
            JSValue settled = JS_PromiseResult(g_ctx, value);
            status = report_value(settled);
            JS_FreeValue(g_ctx, settled);
            break;
        }
        case JS_PROMISE_REJECTED: {
            JSValue reason = JS_PromiseResult(g_ctx, value);
            report_exception(g_ctx, reason);
            JS_FreeValue(g_ctx, reason);
            status = SB_SCRIPT_ERROR;
            break;
        }
        default:
            // Host calls are synchronous, so once the job queue is empty
            // nothing is left that could settle this promise.
            report_c_error("Error",
                "The script awaited a promise that never settled. Host API calls return their values directly; "
                "a promise you create yourself must be resolved by your own code.");
            status = SB_SCRIPT_ERROR;
            break;
    }

    JS_FreeValue(g_ctx, value);
    return status;
}
