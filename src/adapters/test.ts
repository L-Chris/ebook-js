/**
 * Test adapter implementations.
 *
 * These use @xmldom/xmldom (proper XML DOM for Node.js) to enable
 * testing the EPUB parser without a browser.
 */

import type { DOMAdapter, XMLDocument, XMLElement, XMLAttr } from '../core/dom-adapter'
import type { URLFactory } from '../core/url-factory'

// xmldom types
interface XmldomDocument {
  documentElement: XmldomElement
  getElementById(id: string): XmldomElement | null
  getElementsByTagNameNS(ns: string, name: string): XmldomNodeList
  getElementsByTagName(name: string): XmldomNodeList
  querySelector?(selector: string): XmldomElement | null
  querySelectorAll?(selector: string): XmldomNodeList
  lookupNamespaceURI(prefix: string | null): string | null
  lookupPrefix(ns: string): string | null
}

interface XmldomElement {
  localName: string
  namespaceURI: string | null
  children?: XmldomNodeList
  childNodes: XmldomNodeList
  textContent: string | null
  attributes: XmldomNamedNodeMap
  getAttribute(name: string): string | null
  getAttributeNS(ns: string | null, name: string): string | null
  hasAttribute(name: string): boolean
  setAttribute(name: string, value: string): void
  setAttributeNS(ns: string | null, name: string, value: string): void
  querySelector?(selector: string): XmldomElement | null
  querySelectorAll?(selector: string): XmldomNodeList
  getElementsByTagNameNS(ns: string, name: string): XmldomNodeList
  getElementsByTagName(name: string): XmldomNodeList
  ownerDocument: XmldomDocument | null
  lookupNamespaceURI(prefix: string | null): string | null
  lookupPrefix(ns: string): string | null
}

interface XmldomNodeList {
  length: number
  item(index: number): XmldomElement | null
  [index: number]: XmldomElement
  [Symbol.iterator](): Iterator<XmldomElement>
}

interface XmldomNamedNodeMap {
  length: number
  item(index: number): { localName: string; namespaceURI: string | null; value: string } | null
  [index: number]: { localName: string; namespaceURI: string | null; value: string }
  [Symbol.iterator](): Iterator<{ localName: string; namespaceURI: string | null; value: string }>
}

/**
 * Convert xmldom NodeList to array
 */
function nodeListToArray(list: XmldomNodeList | undefined): XmldomElement[] {
  if (!list) return []
  const result: XmldomElement[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list.item(i)
    if (item) result.push(item)
  }
  return result
}

/**
 * Filter child nodes to only include Elements (nodeType === 1)
 */
function getElementChildren(el: XmldomElement): XmldomElement[] {
  const children: XmldomElement[] = []
  const childNodes = el.childNodes
  for (let i = 0; i < childNodes.length; i++) {
    const child = childNodes.item(i) as unknown as { nodeType: number }
    // nodeType 1 = ELEMENT_NODE
    if (child && child.nodeType === 1) {
      children.push(child as unknown as XmldomElement)
    }
  }
  return children
}

/**
 * Wrapper for xmldom Element to satisfy XMLElement interface.
 */
class XmldomXMLElement implements XMLElement {
  constructor(private el: XmldomElement) {}

  get localName(): string {
    return this.el.localName
  }

  get namespaceURI(): string | null {
    return this.el.namespaceURI
  }

  get children(): XMLElement[] {
    return getElementChildren(this.el).map(c => new XmldomXMLElement(c))
  }

  get textContent(): string | null {
    return this.el.textContent
  }

  get attributes(): XMLAttr[] {
    const attrs = this.el.attributes
    const result: XMLAttr[] = []
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs.item(i)
      if (attr) {
        result.push({
          localName: attr.localName,
          namespaceURI: attr.namespaceURI,
          value: attr.value,
        })
      }
    }
    return result
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
    // xmldom doesn't have querySelector, implement basic ID selector
    if (selector.startsWith('#')) {
      const id = selector.slice(1)
      const doc = this.el.ownerDocument
      if (doc) {
        const el = doc.getElementById(id)
        return el ? new XmldomXMLElement(el) : null
      }
    }
    // For attribute selectors like [name="..."]
    const attrMatch = selector.match(/^\[(\w+)="([^"]+)"\]$/)
    if (attrMatch) {
      const [, attrName, attrValue] = attrMatch
      const found = this.findByAttribute(attrName, attrValue)
      return found ? new XmldomXMLElement(found) : null
    }
    return null
  }

  private findByAttribute(name: string, value: string): XmldomElement | null {
    if (this.el.getAttribute(name) === value) return this.el
    for (const child of getElementChildren(this.el)) {
      const found = new XmldomXMLElement(child).findByAttribute(name, value)
      if (found) return found
    }
    return null
  }

  querySelectorAll(selector: string): XMLElement[] {
    // xmldom doesn't have querySelectorAll, implement basic selectors
    const results: XmldomElement[] = []

    // Tag name selector
    if (/^[a-zA-Z][\w-]*$/.test(selector)) {
      const elements = this.el.getElementsByTagName(selector)
      return nodeListToArray(elements).map(e => new XmldomXMLElement(e))
    }

    // Attribute selectors
    if (selector.startsWith('[')) {
      this.collectByAttribute(selector, results)
      return results.map(e => new XmldomXMLElement(e))
    }

    return results.map(e => new XmldomXMLElement(e))
  }

  private collectByAttribute(selector: string, results: XmldomElement[]): void {
    // Parse selector like [src], [href], [*|href]:not([href])
    const attrMatch = selector.match(/^\[(?:\*\|)?(\w+)\]/)
    if (attrMatch) {
      const attrName = attrMatch[1]
      this.collectWithAttribute(attrName, results)
    }
  }

  private collectWithAttribute(attrName: string, results: XmldomElement[]): void {
    if (this.el.hasAttribute(attrName) || this.el.getAttributeNS('http://www.w3.org/1999/xlink', attrName)) {
      results.push(this.el)
    }
    for (const child of getElementChildren(this.el)) {
      new XmldomXMLElement(child).collectWithAttribute(attrName, results)
    }
  }

  getElementsByTagNameNS(ns: string, name: string): XMLElement[] {
    return nodeListToArray(this.el.getElementsByTagNameNS(ns, name)).map(e => new XmldomXMLElement(e))
  }

  getElementsByTagName(name: string): XMLElement[] {
    return nodeListToArray(this.el.getElementsByTagName(name)).map(e => new XmldomXMLElement(e))
  }

  get ownerDocument(): XMLDocument | null {
    return this.el.ownerDocument ? new XmldomXMLDocument(this.el.ownerDocument) : null
  }

  lookupNamespaceURI(prefix: string | null): string | null {
    return this.el.lookupNamespaceURI(prefix)
  }

  lookupPrefix(ns: string): string | null {
    return this.el.lookupPrefix(ns)
  }
}

/**
 * Wrapper for xmldom Document to satisfy XMLDocument interface.
 */
class XmldomXMLDocument implements XMLDocument {
  constructor(private doc: XmldomDocument) {}

  get documentElement(): XMLElement {
    return new XmldomXMLElement(this.doc.documentElement)
  }

  getElementById(id: string): XMLElement | null {
    const el = this.doc.getElementById(id)
    return el ? new XmldomXMLElement(el) : null
  }

  getElementsByTagNameNS(ns: string, name: string): XMLElement[] {
    return nodeListToArray(this.doc.getElementsByTagNameNS(ns, name)).map(e => new XmldomXMLElement(e))
  }

  getElementsByTagName(name: string): XMLElement[] {
    return nodeListToArray(this.doc.getElementsByTagName(name)).map(e => new XmldomXMLElement(e))
  }

  querySelector(selector: string): XMLElement | null {
    // Handle parsererror check - xmldom doesn't create parsererror elements the same way
    if (selector === 'parsererror') {
      return null
    }
    // Handle ID selectors
    if (selector.startsWith('#')) {
      return this.getElementById(selector.slice(1))
    }
    // Handle tag name selectors
    if (/^[a-zA-Z][\w-]*$/.test(selector)) {
      const elements = this.doc.getElementsByTagName(selector)
      if (elements.length > 0) {
        return new XmldomXMLElement(elements.item(0)!)
      }
    }
    return null
  }

  querySelectorAll(selector: string): XMLElement[] {
    // Handle tag name selectors
    if (/^[a-zA-Z][\w-]*$/.test(selector)) {
      return nodeListToArray(this.doc.getElementsByTagName(selector)).map(e => new XmldomXMLElement(e))
    }
    // Handle attribute selectors like link[href]
    const tagAttrMatch = selector.match(/^(\w+)\[(\w+)\]$/)
    if (tagAttrMatch) {
      const [, tagName, attrName] = tagAttrMatch
      const elements = this.doc.getElementsByTagName(tagName)
      const results: XMLElement[] = []
      for (let i = 0; i < elements.length; i++) {
        const el = elements.item(i)
        if (el && el.hasAttribute(attrName)) {
          results.push(new XmldomXMLElement(el))
        }
      }
      return results
    }
    // Handle generic attribute selectors [attr]
    const attrMatch = selector.match(/^\[(?:\*\|)?(\w+)\](?::not\(\[\w+\]\))?$/)
    if (attrMatch) {
      const attrName = attrMatch[1]
      return this.findAllWithAttribute(attrName)
    }
    return []
  }

  private findAllWithAttribute(attrName: string): XMLElement[] {
    const results: XMLElement[] = []
    const walk = (el: XmldomElement) => {
      if (el.hasAttribute(attrName) ||
          (attrName === 'href' && el.getAttributeNS('http://www.w3.org/1999/xlink', 'href'))) {
        results.push(new XmldomXMLElement(el))
      }
      for (const child of getElementChildren(el)) {
        walk(child)
      }
    }
    if (this.doc.documentElement) {
      walk(this.doc.documentElement)
    }
    return results
  }

  lookupNamespaceURI(prefix: string | null): string | null {
    return this.doc.lookupNamespaceURI(prefix)
  }

  lookupPrefix(ns: string): string | null {
    return this.doc.lookupPrefix(ns)
  }

  toNative(): XmldomDocument {
    return this.doc
  }
}

/**
 * Test implementation of DOMAdapter using @xmldom/xmldom.
 */
export class TestDOMAdapter implements DOMAdapter {
  private DOMParser: new () => { parseFromString(str: string, mimeType: string): XmldomDocument }
  private XMLSerializer: new () => { serializeToString(doc: XmldomDocument): string }

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const xmldom = require('@xmldom/xmldom')
    this.DOMParser = xmldom.DOMParser
    this.XMLSerializer = xmldom.XMLSerializer
  }

  parseXML(str: string): XMLDocument {
    const parser = new this.DOMParser()
    const doc = parser.parseFromString(str, 'application/xml')
    return new XmldomXMLDocument(doc)
  }

  parseHTML(str: string, _mimeType: string = 'text/html'): XMLDocument {
    // For tests, use XML parser for HTML as well
    const parser = new this.DOMParser()
    const doc = parser.parseFromString(str, 'text/html')
    return new XmldomXMLDocument(doc)
  }

  serialize(doc: XMLDocument): string {
    const nativeDoc = doc.toNative?.() as XmldomDocument
    if (!nativeDoc) throw new Error('XMLDocument does not support toNative()')
    const serializer = new this.XMLSerializer()
    return serializer.serializeToString(nativeDoc)
  }
}

/**
 * Test implementation of URLFactory using fake URLs.
 */
export class TestURLFactory implements URLFactory {
  private counter = 0
  private urls = new Map<string, { data: string | ArrayBuffer; mimeType: string }>()

  createURL(data: string | ArrayBuffer, mimeType: string): string {
    const url = `test://resource-${this.counter++}`
    this.urls.set(url, { data, mimeType })
    return url
  }

  revokeURL(url: string): void {
    this.urls.delete(url)
  }

  // Test helper: get stored data for a URL
  getData(url: string): { data: string | ArrayBuffer; mimeType: string } | undefined {
    return this.urls.get(url)
  }

  // Test helper: check if URL exists
  hasURL(url: string): boolean {
    return this.urls.has(url)
  }
}
