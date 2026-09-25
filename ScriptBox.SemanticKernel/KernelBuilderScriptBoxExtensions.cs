using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.SemanticKernel;
using ScriptBox;

namespace ScriptBox.SemanticKernel;

/// <summary>
/// Extension methods for wiring ScriptBox into a Semantic Kernel builder.
/// </summary>
public static class KernelBuilderScriptBoxExtensions
{
    /// <summary>
    /// Adds a configured ScriptBox instance plus the <see cref="ScriptBoxPlugin"/> to the kernel builder.
    /// Also registers <see cref="SemanticKernelToolProvider"/> so tools can be discovered and exposed to scripts.
    /// </summary>
    /// <param name="builder">The kernel builder to enrich.</param>
    /// <param name="configure">Optional callback for configuring the underlying <see cref="IScriptBoxConfigurator"/>.</param>
    /// <param name="pluginName">The plugin name exposed to Semantic Kernel (defaults to "scriptbox").</param>
    /// <param name="enableDiscovery">Whether to automatically register the discovery plugin (defaults to true).</param>
    /// <param name="discoveryPluginName">The name of the discovery plugin if enabled (defaults to "scriptbox_discovery").</param>
    /// <returns>The provided builder to enable chaining.</returns>
    public static IKernelBuilder AddScriptBox(
        this IKernelBuilder builder,
        Action<IScriptBoxConfigurator>? configure = null,
        string pluginName = "scriptbox",
        bool enableDiscovery = true,
        string discoveryPluginName = "scriptbox_discovery")
    {
        if (builder is null)
        {
            throw new ArgumentNullException(nameof(builder));
        }

        if (string.IsNullOrWhiteSpace(pluginName))
        {
            throw new ArgumentException("Plugin name must be provided.", nameof(pluginName));
        }

        builder.Services.TryAddSingleton<IScriptBox>(services =>
        {
            var scriptBoxBuilder = ScriptBoxBuilder
                .Create()
                .WithApiFactory(type => ActivatorUtilities.GetServiceOrCreateInstance(services, type))
                .WithApiScanner(new SemanticKernelApiScanner());

            configure?.Invoke(scriptBoxBuilder);

            return scriptBoxBuilder.Build();
        });

        // Register the tool provider that reads metadata from the built ScriptBox instance
        builder.Services.TryAddSingleton<IScriptBoxToolProvider>(sp =>
        {
            var scriptBox = sp.GetRequiredService<IScriptBox>();
            return new ScriptBoxMetadataToolProvider(scriptBox);
        });

        builder.Plugins.AddFromType<ScriptBoxPlugin>(pluginName);

        if (enableDiscovery)
        {
            builder.Plugins.AddFromType<ScriptBoxDiscoveryPlugin>(discoveryPluginName);
        }

        return builder;
    }
}
