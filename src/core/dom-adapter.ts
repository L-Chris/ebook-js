/**
 * DOM Adapter interfaces.
 *
 * These interfaces abstract DOM parsing and querying operations,
 * allowing the EPUB parser to run in any environment (browser, Node.js, workers).
 *
 * Implementations:
 * - Browser: wraps native DOMParser/XMLSerializer
 * - Test: uses linkedom or a lightweight parser
 */

/**
 * Minimal attribute representation.
 */
export interface XMLAttr {
  localName: string
  namespaceURI: string | null
  value: string
}

/**
 * Minimal element interface for XML/HTML querying.
 */
export interface XMLElement {
  localName: string
  namespaceURI: string | null
  children: XMLElement[]
  textContent: string | null
  attributes: XMLAttr[]

  getAttribute(name: string): string | null
  getAttributeNS(ns: string | null, name: string): string | null
  hasAttribute(name: string): boolean
  setAttribute(name: string, value: string): void
  setAttributeNS(ns: string | null, name: string, value: string): void

  querySelector(selector: string): XMLElement | null
  querySelectorAll(selector: string): XMLElement[]
  getElementsByTagNameNS(ns: string, name: string): XMLElement[]
  getElementsByTagName(name: string): XMLElement[]

  ownerDocument: XMLDocument | null
  lookupNamespaceURI(prefix: string | null): string | null
  lookupPrefix(ns: string): string | null
}

/**
 * Minimal document interface for XML/HTML parsing.
 */
export interface XMLDocument {
  documentElement: XMLElement
  getElementById(id: string): XMLElement | null
  getElementsByTagNameNS(ns: string, name: string): XMLElement[]
  getElementsByTagName(name: string): XMLElement[]
  querySelector(selector: string): XMLElement | null
  querySelectorAll(selector: string): XMLElement[]
  lookupNamespaceURI(prefix: string | null): string | null
  lookupPrefix(ns: string): string | null

  /**
   * Return the underlying native document object.
   * Used by adapters that need to unwrap the document (e.g. for serialization).
   */
  toNative?(): unknown
}

/**
 * DOM adapter for parsing and serializing XML/HTML.
 */
export interface DOMAdapter {
  /**
   * Parse an XML string into a document.
   * @throws Error if parsing fails
   */
  parseXML(str: string): XMLDocument

  /**
   * Parse an HTML/XHTML string into a document.
   * @param mimeType - The MIME type (e.g., 'application/xhtml+xml', 'text/html')
   */
  parseHTML(str: string, mimeType?: string): XMLDocument

  /**
   * Serialize a document back to a string.
   */
  serialize(doc: XMLDocument): string
}
