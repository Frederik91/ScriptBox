using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace ScriptBox.Core.Runtime;

internal static class AttributedSandboxApiRegistry
{
    public static string BuildBootstrap(IEnumerable<SandboxApiDescriptor> apis)
    {
        var sb = new StringBuilder();
        foreach (var api in apis)
        {
            if (api.Methods.Count == 0)
            {
                continue;
            }

            sb.AppendLine("(function(root){");
            sb.AppendLine("  var api = {};");
            foreach (var method in api.Methods)
            {
                sb.AppendLine($"  api.{method.JsMethodName} = __scriptbox.createMethod({JsonSerializer.Serialize(method.HostMethodName)});");
            }
            sb.AppendLine($"  root.{api.JsNamespace} = Object.freeze(api);");
            sb.AppendLine("})(globalThis);");
        }

        return sb.ToString();
    }

    public static void RegisterHandlers(IEnumerable<SandboxApiDescriptor> apis, HostApiBuilder builder)
    {
        foreach (var api in apis)
        {
            foreach (var method in api.Methods)
            {
                builder.RegisterHandler(method.HostMethodName, CreateHandler(api, method));
            }
        }
    }

    private static HostMethodHandler CreateHandler(SandboxApiDescriptor api, SandboxMethodDescriptor descriptor)
    {
        var declaredType = GetDeclaredResultType(descriptor.Method.ReturnType);
        var parameters = descriptor.Method.GetParameters();
        var nullability = parameters.Select(IsNullable).ToArray();

        return async ctx =>
        {
            var target = api.RequiresInstance ? ctx.ResolveInstance(api) : null;
            var arguments = BindArguments(descriptor, parameters, nullability, ctx);

            object? returned;
            try
            {
                returned = descriptor.Method.Invoke(target, arguments);
            }
            catch (TargetInvocationException ex) when (ex.InnerException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
                throw;
            }

            var value = await UnwrapResultAsync(returned).ConfigureAwait(false);
            return new HostCallResult(value, declaredType);
        };
    }

    private static object?[] BindArguments(
        SandboxMethodDescriptor descriptor,
        ParameterInfo[] parameters,
        bool[] nullability,
        HostCallContext ctx)
    {
        var values = new object?[parameters.Length];
        var argIndex = 0;

        for (var i = 0; i < parameters.Length; i++)
        {
            var parameter = parameters[i];
            if (parameter.ParameterType == typeof(HostCallContext))
            {
                values[i] = ctx;
                continue;
            }

            if (parameter.ParameterType == typeof(CancellationToken))
            {
                values[i] = ctx.CancellationToken;
                continue;
            }

            var supplied = argIndex < ctx.Arguments.Count ? ctx.Arguments[argIndex] : (JsonElement?)null;
            argIndex++;

            if (supplied is null || supplied.Value.ValueKind == JsonValueKind.Null)
            {
                if (parameter.HasDefaultValue)
                {
                    values[i] = parameter.DefaultValue;
                }
                else if (nullability[i])
                {
                    values[i] = null;
                }
                else
                {
                    throw new ScriptApiException(
                        $"{descriptor.HostMethodName} requires the argument '{parameter.Name}'.", "TypeError");
                }

                continue;
            }

            try
            {
                values[i] = supplied.Value.Deserialize(parameter.ParameterType, ctx.JsonOptions);
            }
            catch (JsonException ex)
            {
                throw new ScriptApiException(
                    $"{descriptor.HostMethodName}: the argument '{parameter.Name}' is not a valid {parameter.ParameterType.Name}. {ex.Message}",
                    "TypeError");
            }
        }

        if (ctx.Arguments.Count > argIndex)
        {
            throw new ScriptApiException(
                $"{descriptor.HostMethodName} takes {argIndex} argument(s) but was given {ctx.Arguments.Count}.",
                "TypeError");
        }

        return values;
    }

    private static bool IsNullable(ParameterInfo parameter)
    {
        var type = parameter.ParameterType;
        if (type.IsValueType)
        {
            return Nullable.GetUnderlyingType(type) is not null;
        }

#if NET6_0_OR_GREATER
        return new NullabilityInfoContext().Create(parameter).WriteState != NullabilityState.NotNull;
#else
        return true;
#endif
    }

    internal static Type GetDeclaredResultType(Type returnType)
    {
        if (returnType == typeof(void) || returnType == typeof(Task) || returnType == typeof(ValueTask))
        {
            return typeof(void);
        }

        if (returnType.IsGenericType)
        {
            var definition = returnType.GetGenericTypeDefinition();
            if (definition == typeof(Task<>) || definition == typeof(ValueTask<>))
            {
                return returnType.GetGenericArguments()[0];
            }
        }

        return returnType;
    }

    private static async Task<object?> UnwrapResultAsync(object? result)
    {
        switch (result)
        {
            case null:
                return null;
            case Task task:
                await task.ConfigureAwait(false);
                return task.GetType().IsGenericType ? GetTaskResult(task) : null;
            case ValueTask valueTask:
                await valueTask.AsTask().ConfigureAwait(false);
                return null;
        }

        var type = result.GetType();
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ValueTask<>))
        {
            var task = (Task)type.GetMethod("AsTask")!.Invoke(result, null)!;
            await task.ConfigureAwait(false);
            return GetTaskResult(task);
        }

        return result;
    }

    private static object? GetTaskResult(Task task)
    {
        return task.GetType().GetProperty("Result", BindingFlags.Instance | BindingFlags.Public)?.GetValue(task);
    }

    public static bool TryCreateDescriptor(Type type, string? namespaceOverride, [NotNullWhen(true)] out SandboxApiDescriptor? descriptor)
    {
        descriptor = null;

        var apiName = namespaceOverride;
        if (apiName is null)
        {
            var apiAttribute = type.GetCustomAttribute<SandboxApiAttribute>();
            if (apiAttribute is null)
            {
                return false;
            }
            apiName = apiAttribute.Name;
        }

        var isStatic = type.IsAbstract && type.IsSealed;
        var flags = BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly;
        if (!isStatic)
        {
            flags |= BindingFlags.Instance;
        }

        var methods = new List<SandboxMethodDescriptor>();
        foreach (var method in type.GetMethods(flags))
        {
            var methodAttribute = method.GetCustomAttribute<SandboxMethodAttribute>();
            if (methodAttribute is not null)
            {
                methods.Add(new SandboxMethodDescriptor(apiName, methodAttribute.Name, method));
            }
        }

        if (methods.Count == 0)
        {
            return false;
        }

        var requiresInstance = methods.Any(m => !m.Method.IsStatic);
        descriptor = new SandboxApiDescriptor(type, apiName, methods, requiresInstance);
        return true;
    }
}
