import Foundation

/// Keeps the local database and the saved files out of iCloud and device backups.
///
/// Both hold work that was never uploaded. The database key lives in the keychain and does not travel with a backup,
/// so a restored copy of the file could never be opened again; leaving it out of backups avoids creating one.
/// The directories are relative to `Library` and must match `iosDatabaseLocation` in capacitor.config.ts
/// (`Library/CapacitorDatabase`) and `Directory.LibraryNoCloud` (`Library/NoCloud`); `src/ios-config.test.ts` checks both.
enum BackupExclusion {
    static let relativeDirectories: [String] = ["CapacitorDatabase", "NoCloud"]

    /// Creates each directory if it is missing, then marks it excluded from backup. One failing directory does not
    /// stop the others; the first error is thrown at the end.
    static func apply(under library: URL, fileManager: FileManager) throws {
        var firstError: Error?
        for relative in relativeDirectories {
            do {
                var url = library.appendingPathComponent(relative, isDirectory: true)
                try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try url.setResourceValues(values)
            } catch {
                if firstError == nil { firstError = error }
            }
        }
        if let error = firstError { throw error }
    }
}
