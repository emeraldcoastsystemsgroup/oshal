/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 — Keychain-backed string store for the device-pairing token + host URL. Purpose: keep the bearer token out of UserDefaults/plist and off disk in the clear.
 */

import Foundation
import Security

/// @description A minimal Keychain wrapper for small strings (the OSHAL host URL
/// and the device-pairing bearer token). Uses a generic-password item keyed by a
/// service + account so values survive app relaunches but never land in a plist or
/// UserDefaults. Access is limited to when the device is unlocked.
struct KeychainTokenStore {
    /// The keychain service namespace for this app's secrets.
    private let service = "com.emeraldcoastsystemsgroup.oshal.spacesscanner"

    /// Keychain accounts (item keys) this store manages.
    enum Key: String {
        case host = "oshal.host"
        case token = "oshal.pairing-token"
    }

    /// @description Store (or replace) a string value for a key. An empty value
    /// deletes the item so callers can "clear" by writing "".
    /// @param value The string to persist.
    /// @param key Which item to write.
    /// @returns Discardable success flag (false only on an unexpected OSStatus).
    @discardableResult
    func set(_ value: String, for key: Key) -> Bool {
        if value.isEmpty { return delete(key) }
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        // Update if present, otherwise add — SecItemUpdate fails when absent.
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        if updateStatus == errSecItemNotFound {
            var addQuery = query
            addQuery.merge(attributes) { current, _ in current }
            return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
        }
        return false
    }

    /// @description Read the string value for a key.
    /// @param key Which item to read.
    /// @returns The stored string, or nil if absent.
    func get(_ key: Key) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }

    /// @description Delete the item for a key.
    /// @param key Which item to remove.
    /// @returns True when removed or already absent.
    @discardableResult
    func delete(_ key: Key) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
