/**
 * Browser adapter implementations.
 *
 * These wrap native browser APIs (DOMParser, XMLSerializer, URL.createObjectURL)
 * to satisfy the adapter interfaces.
 */

import type { DOMAdapter, XMLDocument, XMLElement, XMLAttr } from '../core/dom-adapter'
import type { URLFactory } from '../core/url-factory'

/**
 * Wrapper for native DOM Element to satisfy XMLElement interface.
 */
class BrowserXMLElement implements XMLElement {
  constructor(private el: Element) {}

  get localName(): string {
    return this.el.localName
  }

  get namespaceURI(): string | null {
    return this.el.namespaceURI
  }

  get children(): XMLElement[] {
    return Array.from(this.el.children).map(c => new BrowserXMLElement(c))
  }

  get textContent(): string | null {
    return this.el.textContent
  }

  get attributes(): XMLAttr[] {
    return Array.from(this.el.attributes).map(attr => ({
      localName: attr.localName,
      namespaceURI: attr.namespaceURI,
      value: attr.value,
    }))
  }

  getAttribute(name: string): string | null {
    return this.el.getAttribute(name)
  }

  getAttributeNS(ns: string | null, name: string): string | null {
    return this.el.getAttributeNS(ns, name)
  }

  hasAttribute(name: string): boolean {
    return this.el.hasAttribute(name)
  }

  setAttribute(name: string, value: string): void {
    this.el.setAttribute(name, value)
  }

  setAttributeNS(ns: string | null, name: string, value: string): void {
    this.el.setAttributeNS(ns, name, value)
  }

  querySelector(selector: string): XMLElement | null {
    const result = this.el.querySelector(selector)
    return result ? new BrowserXMLElement(result) : null
  }

  querySelectorAll(selector: string): XMLElement[] {
    return Array.from(this.el.querySelectorAll(selector)).map(e => new BrowserXMLElement(e))
  }

  getElementsByTagNameNS(ns: string, name: string): XMLElement[] {
    return Array.from(this.el.getElementsByTagNameNS(ns, name)).map(e => new BrowserXMLElement(e))
  }

  getElementsByTagName(name: string): XMLElement[] {
    return Array.from(this.el.getElementsByTagName(name)).map(e => new BrowserXMLElement(e))
  }

  get ownerDocument(): XMLDocument | null {
    return this.el.ownerDocument ? new BrowserXMLDocument(this.el.ownerDocument) : null
  }

  lookupNamespaceURI(prefix: string | null): string | null {
    return this.el.lookupNamespaceURI(prefix)
  }

  lookupPrefix(ns: string): string | null {
    return this.el.lookupPrefix(ns)
  }
}

/**
 * Wrapper for native DOM Document to satisfy XMLDocument interface.
 */
class BrowserXMLDocument implements XMLDocument {
  constructor(private doc: Document) {}

  get documentElement(): XMLElement {
    return new BrowserXMLElement(this.doc.documentElement)
  }

  getElementById(id: string): XMLElement | null {
    const el = this.doc.getElementById(id)
    return el ? new BrowserXMLElement(el) : null
  }

  getElementsByTagNameNS(ns: string, name: string): XMLElement[] {
    return Array.from(this.doc.getElementsByTagNameNS(ns, name)).map(e => new BrowserXMLElement(e))
  }

  getElementsByTagName(name: string): XMLElement[] {
    return Array.from(this.doc.getElementsByTagName(name)).map(e => new BrowserXMLElement(e))
  }

  querySelector(selector: string): XMLElement | null {
    const result = this.doc.querySelector(selector)
    return result ? new BrowserXMLElement(result) : null
  }

  querySelectorAll(selector: string): XMLElement[] {
    return Array.from(this.doc.querySelectorAll(selector)).map(e => new BrowserXMLElement(e))
  }

  lookupNamespaceURI(prefix: string | null): string | null {
    return this.doc.lookupNamespaceURI(prefix)
  }

  lookupPrefix(ns: string): string | null {
    return this.doc.lookupPrefix(ns)
  }

  toNative(): Document {
    return this.doc
  }
}

/**
 * Browser implementation of DOMAdapter using native DOMParser/XMLSerializer.
 */
export class BrowserDOMAdapter implements DOMAdapter {
  private parser = new DOMParser()
  private serializer = new XMLSerializer()

  parseXML(str: string): XMLDocument {
    const doc = this.parser.parseFromString(str, 'application/xml')
    const parseError = doc.querySelector('parsererror')
    if (parseError) {
      throw new Error(`XML parsing error: ${parseError.textContent}`)
    }
    return new BrowserXMLDocument(doc)
  }

  parseHTML(str: string, mimeType: string = 'text/html'): XMLDocument {
    const doc = this.parser.parseFromString(str, mimeType as DOMParserSupportedType)
    return new BrowserXMLDocument(doc)
  }

  serialize(doc: XMLDocument): string {
    const nativeDoc = doc.toNative?.() as Document
    if (!nativeDoc) throw new Error('XMLDocument does not support toNative()')
    return this.serializer.serializeToString(nativeDoc)
  }
}

/**
 * Browser implementation of URLFactory using URL.createObjectURL.
 */
export class BrowserURLFactory implements URLFactory {
  createURL(data: string | ArrayBuffer, mimeType: string): string {
    const blob = new Blob([data], { type: mimeType })
    return URL.createObjectURL(blob)
  }

  revokeURL(url: string): void {
    URL.revokeObjectURL(url)
  }
}
