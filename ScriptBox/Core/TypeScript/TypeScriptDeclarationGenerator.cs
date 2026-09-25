using System.Collections;
using System.ComponentModel;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using ScriptBox.Core.Runtime;

namespace ScriptBox.Core.TypeScript;

/// <summary>
/// Declares the registered APIs, and every type reachable from their
/// signatures, as TypeScript. The shapes follow the serializer options the
/// box uses on the wire: on .NET 8 and later they are read from System.Text.Json's
/// own contract, so renamed and ignored members and polymorphic hierarchies
/// come out as they are actually sent.
/// </summary>
internal sealed class TypeScriptDeclarationGenerator
{
    private readonly JsonSerializerOptions _options;
    private readonly IReadOnlyDictionary<Type, string> _overrides;
    private readonly Dictionary<Type, string> _names = new();
    private readonly HashSet<string> _usedNames = new(StringComparer.Ordinal);
    private readonly Queue<Type> _pending = new();
    private readonly HashSet<Type> _written = new();
    private readonly bool _enumsAsStrings;
#if NET6_0_OR_GREATER
    private readonly NullabilityInfoContext _nullability = new();
#endif

    public TypeScriptDeclarationGenerator(JsonSerializerOptions options, IReadOnlyDictionary<Type, string> overrides)
    {
        _options = options;
        _overrides = overrides;
        _enumsAsStrings = options.Converters.Any(IsStringEnumConverter);
        if (!options.IsReadOnly)
        {
            options.MakeReadOnly(populateMissingResolver: true);
        }
    }

    public string Generate(IEnumerable<SandboxApiDescriptor> apis)
    {
        var sb = new StringBuilder();
        foreach (var api in apis)
        {
            WriteApi(sb, api);
        }

        while (_pending.Count > 0)
        {
            var type = _pending.Dequeue();
            if (_written.Add(type))
            {
                WriteType(sb, type);
            }
        }

        return sb.ToString().Replace("\r\n", "\n").TrimEnd() + "\n";
    }

    private void WriteApi(StringBuilder sb, SandboxApiDescriptor api)
    {
        WriteDoc(sb, "", Describe(api.ApiType), Array.Empty<string>());
        sb.Append("declare const ").Append(api.JsNamespace).AppendLine(": {");
        foreach (var method in api.Methods)
        {
            var parameters = method.Method.GetParameters()
                .Where(p => p.ParameterType != typeof(HostCallContext) && p.ParameterType != typeof(CancellationToken))
                .ToList();

            var tags = parameters
                .Where(p => Describe(p) is not null)
                .Select(p => $"@param {p.Name} {Describe(p)}")
                .ToList();
            WriteDoc(sb, "  ", Describe(method.Method), tags);

            // A parameter can only be optional if every one after it is too.
            var optional = new bool[parameters.Count];
            for (var i = parameters.Count - 1; i >= 0; i--)
            {
                var canOmit = parameters[i].HasDefaultValue || IsNullable(parameters[i]);
                optional[i] = canOmit && (i == parameters.Count - 1 || optional[i + 1]);
            }

            var signature = string.Join(", ", parameters.Select((p, i) =>
                $"{p.Name}{(optional[i] ? "?" : "")}: {Reference(p.ParameterType, IsNullable(p))}"));
            var returnType = AttributedSandboxApiRegistry.GetDeclaredResultType(method.Method.ReturnType);
            var returns = returnType == typeof(void) ? "void" : Reference(returnType, IsNullableReturn(method.Method));

            sb.Append("  ").Append(method.JsMethodName).Append('(').Append(signature).Append("): ").Append(returns).AppendLine(";");
        }

        sb.AppendLine("};").AppendLine();
    }

    private void WriteType(StringBuilder sb, Type type)
    {
        var name = _names[type];
        if (type.IsEnum)
        {
            WriteEnum(sb, type, name);
            return;
        }

        var derived = GetDerivedTypes(type);
        if (derived.Count > 0)
        {
            WriteDoc(sb, "", Describe(type), Array.Empty<string>());
            sb.Append("type ").Append(name).Append(" = ")
                .Append(string.Join(" | ", derived.Select(d => Reference(d.Type, false)))).AppendLine(";").AppendLine();

            foreach (var (derivedType, discriminator) in derived)
            {
                _written.Add(derivedType);
                WriteInterface(sb, derivedType, _names[derivedType], (GetDiscriminatorName(type), discriminator));
            }
            return;
        }

        if (!HasObjectShape(type))
        {
            WriteDoc(sb, "", Describe(type) ?? "Serialized by a custom converter; its shape is not declared here.", Array.Empty<string>());
            sb.Append("type ").Append(name).AppendLine(" = unknown;").AppendLine();
            return;
        }

        WriteInterface(sb, type, name, null);
    }

    private void WriteInterface(StringBuilder sb, Type type, string name, (string Property, object Value)? discriminator)
    {
        WriteDoc(sb, "", Describe(type), Array.Empty<string>());
        sb.Append("interface ").Append(name).AppendLine(" {");
        if (discriminator is { } d)
        {
            var literal = d.Value is string s ? JsonSerializer.Serialize(s) : Convert.ToString(d.Value, System.Globalization.CultureInfo.InvariantCulture);
            sb.Append("  ").Append(PropertyKey(d.Property)).Append(": ").Append(literal).AppendLine(";");
        }

        foreach (var property in GetProperties(type))
        {
            WriteDoc(sb, "  ", property.Description, Array.Empty<string>());
            sb.Append("  ");
            if (property.ReadOnly)
            {
                sb.Append("readonly ");
            }
            sb.Append(PropertyKey(property.Name)).Append(": ").Append(Reference(property.Type, property.Nullable)).AppendLine(";");
        }

        sb.AppendLine("}").AppendLine();
    }

    private void WriteEnum(StringBuilder sb, Type type, string name)
    {
        var members = type.GetFields(BindingFlags.Public | BindingFlags.Static);
        var tags = members
            .Where(m => m.GetCustomAttribute<DescriptionAttribute>() is not null)
            .Select(m => $"{EnumMemberName(m)}: {m.GetCustomAttribute<DescriptionAttribute>()!.Description}")
            .ToList();
        WriteDoc(sb, "", Describe(type), tags);

        var values = UsesStringEnum(type)
            ? members.Select(m => JsonSerializer.Serialize(EnumMemberName(m)))
            : members.Select(m => Convert.ToString(Convert.ChangeType(m.GetValue(null), Enum.GetUnderlyingType(type), System.Globalization.CultureInfo.InvariantCulture), System.Globalization.CultureInfo.InvariantCulture)!);
        sb.Append("type ").Append(name).Append(" = ").Append(string.Join(" | ", values)).AppendLine(";").AppendLine();
    }

    private string Reference(Type type, bool nullable)
    {
        var underlying = Nullable.GetUnderlyingType(type);
        if (underlying is not null)
        {
            return Reference(underlying, false) + " | null";
        }

        var reference = ReferenceNonNull(type);
        return nullable && reference != "unknown" ? reference + " | null" : reference;
    }

    private string ReferenceNonNull(Type type)
    {
        if (_overrides.TryGetValue(type, out var overridden))
        {
            return overridden;
        }

        if (type == typeof(string) || type == typeof(char) || type == typeof(Guid) || type == typeof(DateTime)
            || type == typeof(DateTimeOffset) || type == typeof(TimeSpan) || type == typeof(Uri) || type == typeof(byte[])
#if NET6_0_OR_GREATER
            || type == typeof(DateOnly) || type == typeof(TimeOnly)
#endif
            )
        {
            return "string";
        }

        if (type == typeof(bool))
        {
            return "boolean";
        }

        if (type.IsPrimitive || type == typeof(decimal))
        {
            return "number";
        }

        if (type == typeof(object) || type == typeof(JsonElement) || type == typeof(JsonDocument) || type == typeof(JsonNode))
        {
            return "unknown";
        }

        if (type == typeof(JsonObject))
        {
            return "Record<string, unknown>";
        }

        if (type == typeof(JsonArray))
        {
            return "unknown[]";
        }

        if (TryGetDictionaryValueType(type, out var valueType))
        {
            return $"Record<string, {Reference(valueType, false)}>";
        }

        if (TryGetElementType(type, out var elementType))
        {
            var element = Reference(elementType, false);
            return element.Contains(' ') ? $"({element})[]" : element + "[]";
        }

        return Name(type);
    }

    private string Name(Type type)
    {
        if (_names.TryGetValue(type, out var existing))
        {
            return existing;
        }

        var baseName = type.Name;
        var tick = baseName.IndexOf('`');
        if (tick >= 0)
        {
            baseName = baseName.Substring(0, tick) + "Of" + string.Join("And", type.GetGenericArguments().Select(a => a.Name));
        }

        var name = baseName;
        for (var i = 2; !_usedNames.Add(name); i++)
        {
            name = baseName + i;
        }

        _names[type] = name;
        _pending.Enqueue(type);
        foreach (var (derived, _) in GetDerivedTypes(type))
        {
            Name(derived);
        }

        return name;
    }

    private sealed record PropertyShape(string Name, Type Type, bool Nullable, bool ReadOnly, string? Description);

    private bool HasObjectShape(Type type) => _options.GetTypeInfo(type).Kind == JsonTypeInfoKind.Object;

    private IEnumerable<PropertyShape> GetProperties(Type type)
    {
        var info = _options.GetTypeInfo(type);
        if (info.Kind != JsonTypeInfoKind.Object)
        {
            return Array.Empty<PropertyShape>();
        }

        return info.Properties
            .Where(p => p.Get is not null)
            .Select(p =>
            {
                var member = p.AttributeProvider as MemberInfo;
                return new PropertyShape(
                    p.Name,
                    p.PropertyType,
                    member is null || IsNullable(member),
                    p.Set is null,
                    member?.GetCustomAttribute<DescriptionAttribute>()?.Description);
            })
            .ToList();
    }

    private IReadOnlyList<(Type Type, object Discriminator)> GetDerivedTypes(Type type)
    {
        if (type.IsEnum || type.IsPrimitive || type == typeof(string))
        {
            return Array.Empty<(Type, object)>();
        }

        var polymorphism = _options.GetTypeInfo(type).PolymorphismOptions;
        if (polymorphism is null)
        {
            return Array.Empty<(Type, object)>();
        }

        return polymorphism.DerivedTypes
            .Where(d => d.TypeDiscriminator is not null && d.DerivedType != type)
            .Select(d => (d.DerivedType, d.TypeDiscriminator!))
            .ToList();
    }

    private string GetDiscriminatorName(Type type)
    {
        return _options.GetTypeInfo(type).PolymorphismOptions?.TypeDiscriminatorPropertyName ?? "$type";
    }

    private static bool TryGetDictionaryValueType(Type type, out Type valueType)
    {
        foreach (var candidate in new[] { type }.Concat(type.GetInterfaces()))
        {
            if (candidate.IsGenericType)
            {
                var definition = candidate.GetGenericTypeDefinition();
                if ((definition == typeof(IDictionary<,>) || definition == typeof(IReadOnlyDictionary<,>))
                    && (candidate.GetGenericArguments()[0] == typeof(string) || candidate.GetGenericArguments()[0].IsEnum))
                {
                    valueType = candidate.GetGenericArguments()[1];
                    return true;
                }
            }
        }

        valueType = typeof(object);
        return false;
    }

    private static bool TryGetElementType(Type type, out Type elementType)
    {
        if (type.IsArray)
        {
            elementType = type.GetElementType()!;
            return true;
        }

        var enumerable = new[] { type }.Concat(type.GetInterfaces())
            .FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>));
        if (enumerable is not null)
        {
            elementType = enumerable.GetGenericArguments()[0];
            return true;
        }

        elementType = typeof(object);
        return typeof(IEnumerable).IsAssignableFrom(type);
    }

    private bool UsesStringEnum(Type enumType)
    {
        var attribute = enumType.GetCustomAttribute<JsonConverterAttribute>();
        return attribute?.ConverterType is { } converterType ? IsStringEnumConverterType(converterType) : _enumsAsStrings;
    }

    private static bool IsStringEnumConverter(JsonConverter converter) => IsStringEnumConverterType(converter.GetType());

    private static bool IsStringEnumConverterType(Type type)
    {
        return type == typeof(JsonStringEnumConverter)
            || (type.IsGenericType && type.GetGenericTypeDefinition().Name.StartsWith("JsonStringEnumConverter", StringComparison.Ordinal));
    }

    private static string EnumMemberName(FieldInfo field)
    {
        // JsonStringEnumMemberNameAttribute arrived in .NET 9; read it by name.
        var renamed = field.GetCustomAttributes()
            .FirstOrDefault(a => a.GetType().Name == "JsonStringEnumMemberNameAttribute");
        return renamed?.GetType().GetProperty("Name")?.GetValue(renamed) as string ?? field.Name;
    }

    private bool IsNullable(ParameterInfo parameter)
    {
        if (parameter.ParameterType.IsValueType)
        {
            return Nullable.GetUnderlyingType(parameter.ParameterType) is not null;
        }
#if NET6_0_OR_GREATER
        return _nullability.Create(parameter).WriteState != NullabilityState.NotNull;
#else
        return true;
#endif
    }

    private bool IsNullableReturn(MethodInfo method)
    {
        var declared = AttributedSandboxApiRegistry.GetDeclaredResultType(method.ReturnType);
        if (declared.IsValueType)
        {
            return false;
        }
#if NET6_0_OR_GREATER
        var info = _nullability.Create(method.ReturnParameter);
        var state = info.Type == declared ? info.ReadState : info.GenericTypeArguments.FirstOrDefault()?.ReadState ?? NullabilityState.Unknown;
        return state == NullabilityState.Nullable;
#else
        return false;
#endif
    }

    private bool IsNullable(MemberInfo member)
    {
#if NET6_0_OR_GREATER
        var info = member switch
        {
            PropertyInfo property => _nullability.Create(property),
            FieldInfo field => _nullability.Create(field),
            _ => null,
        };
        return info is null || info.ReadState != NullabilityState.NotNull;
#else
        return !(member is PropertyInfo { PropertyType.IsValueType: true } p && Nullable.GetUnderlyingType(p.PropertyType) is null);
#endif
    }

    private static string? Describe(ICustomAttributeProvider provider)
    {
        return provider.GetCustomAttributes(typeof(DescriptionAttribute), inherit: false)
            .OfType<DescriptionAttribute>()
            .FirstOrDefault()?.Description;
    }

    private static string PropertyKey(string name)
    {
        var isIdentifier = name.Length > 0
            && (char.IsLetter(name[0]) || name[0] == '_' || name[0] == '$')
            && name.All(c => char.IsLetterOrDigit(c) || c == '_' || c == '$');
        return isIdentifier ? name : JsonSerializer.Serialize(name);
    }

    private static void WriteDoc(StringBuilder sb, string indent, string? description, IReadOnlyList<string> tags)
    {
        if (string.IsNullOrWhiteSpace(description) && tags.Count == 0)
        {
            return;
        }

        var lines = new List<string>();
        if (!string.IsNullOrWhiteSpace(description))
        {
            lines.AddRange(description!.Replace("\r", "").Split('\n'));
        }
        lines.AddRange(tags);

        if (lines.Count == 1)
        {
            sb.Append(indent).Append("/** ").Append(Escape(lines[0])).AppendLine(" */");
            return;
        }

        sb.Append(indent).AppendLine("/**");
        foreach (var line in lines)
        {
            sb.Append(indent).AppendLine(line.Length == 0 ? " *" : " * " + Escape(line));
        }
        sb.Append(indent).AppendLine(" */");
    }

    private static string Escape(string text) => text.Replace("*/", "*\\/");
}
