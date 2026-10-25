using System;

namespace ScriptBox.Core.Runtime;

[AttributeUsage(AttributeTargets.Method)]
public sealed class SandboxMethodAttribute : Attribute
{
    public SandboxMethodAttribute(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            throw new ArgumentException("Method name cannot be null or empty", nameof(name));
        }

        Name = name;
    }

    public string Name { get; }

    /// <summary>
    /// Lets calls to this method run at the same time as other concurrent calls of the same execution, on
    /// thread-pool threads, so a script that awaits several of them together waits about as long as the slowest.
    /// Set it only on a method whose handler is safe to run in parallel with itself and with the other concurrent
    /// methods, typically a read. Every other call runs alone: it starts once the calls before it have finished,
    /// and the calls after it wait for it.
    /// </summary>
    public bool Concurrent { get; set; }
}
