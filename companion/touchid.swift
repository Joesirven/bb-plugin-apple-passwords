import Foundation
import LocalAuthentication

var arguments = Array(CommandLine.arguments.dropFirst())
var policy = LAPolicy.deviceOwnerAuthentication
if let index = arguments.firstIndex(of: "--biometrics-only") {
    arguments.remove(at: index)
    policy = .deviceOwnerAuthenticationWithBiometrics
}
let reason = arguments.first ?? "use a saved password"

let context = LAContext()
var availabilityError: NSError?
guard context.canEvaluatePolicy(policy, error: &availabilityError) else {
    FileHandle.standardError.write((availabilityError?.localizedDescription ?? "unavailable").data(using: .utf8)!)
    exit(2)
}

let semaphore = DispatchSemaphore(value: 0)
var approved = false
context.evaluatePolicy(policy, localizedReason: reason) { success, _ in
    approved = success
    semaphore.signal()
}
semaphore.wait()
exit(approved ? 0 : 1)
