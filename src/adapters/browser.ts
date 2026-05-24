/**
 * Browser adapter implementations.
 *
 * These wrap native browser APIs (DOMParser, XMLSerializer, URL.createObjectURL)
 * to satisfy the adapter interfaces.
 */

import type { DOMAdapter, XMLDocument, XMLElement, XMLAttr, XMLNode, XMLText } from '../core/dom-adapter'
import type { URLFactory } from '../core/url-factory'
import { EBookError } from '../core/errors'

/**
 * Wrapper for native DOM Node to satisfy XMLNode interface.
 */
class BrowserXMLNode implements XMLNode {
  constructor(public node: Node) {}

  get nodeType(): number {
    return this.node.nodeType
  }

  get textContent(): string | null {
    return this.node.textContent
  }

  set textContent(value: string | null) {
    this.node.textContent = value
  }

  get parentNode(): XMLElement | null {
    return this.node.parentNode && this.node.parentNode.nodeType === Node.ELEMENT_NODE
      ? new BrowserXMLElement(this.node.parentNode as Element)
      : null
  }
}

/**
 * Wrapper for native DOM Text to satisfy XMLText interface.
 */
class BrowserXMLText extends BrowserXMLNode implements XMLText {
  constructor(node: Text) {
    super(node)
  }

  get nodeType(): 3 {
    return 3 // Node.TEXT_NODE
  }

  get textContent(): string {
    return (this.node as Text).textContent || ''
  }

  set textContent(value: string) {
    (this.node as Text).textContent = value
  }
}

/**
 * Wrapper for native DOM Element to satisfy XMLElement interface.
 */
class BrowserXMLElement extends BrowserXMLNode implements XMLElement {
  constructor(el: Element) {
    super(el)
  }

  get nodeType(): 1 {
    return 1 // Element.ELEMENT_NODE
  }

  get localName(): string {
    return (this.node as Element).localName
  }

  get namespaceURI(): string | null {
    return (this.node as Element).namespaceURI
  }

  get children(): XMLElement[] {
    return Array.from((this.node as Element).children).map(c => new BrowserXMLElement(c))
  }

  get textContent(): string | null {
    return this.node.textContent
  }

  set textContent(value: string | null) {
    this.node.textContent = value
  }

  get attributes(): XMLAttr[] {
    return Array.from((this.node as Element).attributes).map(attr => ({
      localName: attr.localName,
      namespaceURI: attr.namespaceURI,
      value: attr.value,
    }))
  }

  getAttribute(name: string): string | null {
    return (this.node as Element).getAttribute(name)
  }

  getAttributeNS(ns: string | null, name: string): string | null {
    return (this.node as Element).getAttributeNS(ns, name)
  }

  hasAttribute(name: string): boolean {
    return (this.node as Element).hasAttribute(name)
  }

  setAttribute(name: string, value: string): void {
    (this.node as Element).setAttribute(name, value)
  }

  setAttributeNS(ns: string | null, name: string, value: string): void {
    (this.node as Element).setAttributeNS(ns, name, value)
  }

  querySelector(selector: string): XMLElement | null {
    const result = (this.node as Element).querySelector(selector)
    return result ? new BrowserXMLElement(result) : null
  }

  querySelectorAll(selector: string): XMLElement[] {
    return Array.from((this.node as Element).querySelectorAll(selector)).map(e => new BrowserXMLElement(e))
  }

  getElementsByTagNameNS(ns: string, name: string): XMLElement[] {
    return Array.from((this.node as Element).getElementsByTagNameNS(ns, name)).map(e => new BrowserXMLElement(e))
  }

  getElementsByTagName(name: string): XMLElement[] {
    return Array.from((this.node as Element).getElementsByTagName(name)).map(e => new BrowserXMLElement(e))
  }

  get ownerDocument(): XMLDocument | null {
    return (this.node as Element).ownerDocument ? new BrowserXMLDocument((this.node as Element).ownerDocument) : null
  }

  lookupNamespaceURI(prefix: string | null): string | null {
    return (this.node as Element).lookupNamespaceURI(prefix)
  }

  lookupPrefix(ns: string): string | null {
    return (this.node as Element).lookupPrefix(ns)
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
      throw new EBookError(`XML parsing error: ${parseError.textContent}`, 'ADAPTER_PARSE_ERROR')
    }
    return new BrowserXMLDocument(doc)
  }

  parseHTML(str: string, mimeType: string = 'text/html'): XMLDocument {
    const doc = this.parser.parseFromString(str, mimeType as DOMParserSupportedType)
    return new BrowserXMLDocument(doc)
  }

  serialize(doc: XMLDocument): string {
    const nativeDoc = doc.toNative?.() as Document
    if (!nativeDoc) throw new EBookError('XMLDocument does not support toNative()', 'ADAPTER_ERROR')
    return this.serializer.serializeToString(nativeDoc)
  }

  getChildNodes(element: XMLElement): XMLNode[] {
    const nativeEl = (element as BrowserXMLElement).node
    return Array.from(nativeEl.childNodes).map(node => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return new BrowserXMLElement(node as Element)
      } else if (node.nodeType === Node.TEXT_NODE) {
        return new BrowserXMLText(node as Text)
      }
      // Other node types (comments, etc.) - wrap as generic node
      return new BrowserXMLNode(node)
    })
  }

  createDocument(): XMLDocument {
    const doc = document.implementation.createHTMLDocument()
    return new BrowserXMLDocument(doc)
  }

  createElement(doc: XMLDocument, tagName: string): XMLElement {
    const nativeDoc = doc.toNative?.() as Document
    if (!nativeDoc) throw new EBookError('XMLDocument does not support toNative()', 'ADAPTER_ERROR')
    const element = nativeDoc.createElement(tagName)
    return new BrowserXMLElement(element)
  }

  createTextNode(doc: XMLDocument, text: string): XMLText {
    const nativeDoc = doc.toNative?.() as Document
    if (!nativeDoc) throw new EBookError('XMLDocument does not support toNative()', 'ADAPTER_ERROR')
    const textNode = nativeDoc.createTextNode(text)
    return new BrowserXMLText(textNode)
  }

  appendChild(parent: XMLElement, child: XMLNode): void {
    const nativeParent = (parent as BrowserXMLElement).node as Element
    const nativeChild = (child as BrowserXMLNode).node
    nativeParent.appendChild(nativeChild)
  }
}

/**
 * Browser implementation of URLFactory using URL.createObjectURL.
 */
export class BrowserURLFactory implements URLFactory {
  createURL(data: string | ArrayBuffer | Blob, mimeType?: string): string {
    const blob = data instanceof Blob
      ? data
      : new Blob([data], { type: mimeType || 'application/octet-stream' })
    return URL.createObjectURL(blob)
  }

  revokeURL(url: string): void {
    URL.revokeObjectURL(url)
  }
}
