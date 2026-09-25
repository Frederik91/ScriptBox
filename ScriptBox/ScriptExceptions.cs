namespace ScriptBox;

/// <summary>
/// Raised by <see cref="ScriptSession.RunAsync"/> when the script does not
/// complete. <see cref="ScriptSession.ExecuteAsync"/> returns the same
/// information as a value instead.
/// </summary>
public sealed class ScriptException : Exception
{
    public ScriptException(ScriptError error)
        : base(error.ToString())
    {
        Error = error;
    }

    public ScriptError Error { get; }
}

/// <summary>
/// Thrown by a host API method to reject a call with a message meant for the
/// script's author. The script sees a JavaScript Error with this name and
/// message, and can catch it; left uncaught it ends the script with a stack
/// pointing at the offending call.
/// </summary>
/// <remarks>
/// Any other exception reaches the script too, named "HostError". Throw this
/// type when the message is written for the script author, not for a log.
/// </remarks>
public class ScriptApiException : Exception
{
    public ScriptApiException(string message, string errorName = "ApiError")
        : base(message)
    {
        ErrorName = errorName;
    }

    public string ErrorName { get; }
}
