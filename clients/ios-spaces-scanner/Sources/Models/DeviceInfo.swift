/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — device identity helper. Purpose: report the hardware model identifier (e.g. iPhone16,2) for the upload metadata's deviceModel field.
 */

import Foundation

/// @description Reads the device's hardware model identifier for scan metadata.
/// The raw identifier (e.g. `iPhone16,2` for iPhone 15 Pro Max) is more precise
/// than a marketing name and is what the swarm records as `deviceModel`.
enum DeviceInfo {
    /// @description The hardware model identifier from `uname` (`hw.machine`),
    /// e.g. `iPhone16,2`. On the simulator this returns the host arch identifier.
    /// @returns The model identifier string.
    static var modelIdentifier: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        let identifier = mirror.children.reduce(into: "") { partial, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            partial.append(Character(UnicodeScalar(UInt8(value))))
        }
        return identifier.isEmpty ? "unknown" : identifier
    }
}
