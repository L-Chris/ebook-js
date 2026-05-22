/**
 * Loader interface.
 *
 * A loader provides access to files within an archive (zip), directory,
 * or remote source. Parsers use loaders to read book contents.
 */

/**
 * An entry in the archive/directory.
 */
export interface LoaderEntry {
    /** Full path/filename within the archive */
    filename: string
    /** Uncompressed size in bytes */
    size: number
}

/**
 * The Loader interface provides file-level access to book resources.
 * Used by parsers to read files from zip archives, directories, etc.
 */
export interface Loader {
    /** List of all entries (files) in the archive */
    entries: LoaderEntry[]

    /**
     * Load a file as text.
     * @param filename - Path within the archive
     * @returns File contents as string, or null if not found
     */
    loadText(filename: string): Promise<string | null>

    /**
     * Load a file as a Blob.
     * @param filename - Path within the archive
     * @param type - Optional MIME type override
     * @returns File as Blob, or null if not found
     */
    loadBlob(filename: string, type?: string): Promise<Blob | null>

    /**
     * Get the uncompressed size of a file.
     * @param filename - Path within the archive
     * @returns Size in bytes, or 0 if not found
     */
    getSize(filename: string): number

    /**
     * Get the archive comment (zip comment field).
     * @returns Comment string, or null if not available
     */
    getComment?(): Promise<string | null>
}
