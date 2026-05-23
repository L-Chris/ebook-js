/**
 * Error types for the rebook library.
 * Provides a hierarchy of errors for better error handling and debugging.
 */

/**
 * Base error class for all rebook errors.
 */
export class EBookError extends Error {
    constructor(message: string, public code: string) {
        super(message)
        this.name = 'EBookError'
    }
}

/**
 * Error thrown when parsing fails due to invalid or malformed content.
 */
export class ParseError extends EBookError {
    constructor(message: string, public format?: string) {
        super(message, 'PARSE_ERROR')
        this.name = 'ParseError'
    }
}

/**
 * Error thrown when the input format is not recognized or supported.
 */
export class UnsupportedFormatError extends EBookError {
    constructor(message: string = 'Unsupported file format') {
        super(message, 'UNSUPPORTED_FORMAT')
        this.name = 'UnsupportedFormatError'
    }
}

/**
 * Error thrown when the file is corrupted or severely malformed.
 */
export class CorruptedFileError extends EBookError {
    constructor(message: string, public format?: string) {
        super(message, 'CORRUPTED_FILE')
        this.name = 'CorruptedFileError'
    }
}

/**
 * Error thrown when a required adapter is not provided.
 */
export class AdapterRequiredError extends EBookError {
    constructor(adapter: string) {
        super(`${adapter} is required but was not provided in ParserOptions`, 'ADAPTER_REQUIRED')
        this.name = 'AdapterRequiredError'
    }
}

/**
 * Error thrown when input type is not supported by the parser.
 */
export class UnsupportedInputError extends EBookError {
    constructor(message: string = 'Input type not supported') {
        super(message, 'UNSUPPORTED_INPUT')
        this.name = 'UnsupportedInputError'
    }
}
