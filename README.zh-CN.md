# ebook-js

模块化、可扩展的 Web 电子书解析与渲染库。

灵感来自 [foliate-js](https://github.com/johnfactotum/foliate-js)，但对其架构进行了重构——**解析器**（文件格式处理）与**渲染器**（平台相关展示）完全解耦。

## 特性

- **模块化架构**：解析器与渲染器相互独立，可自由组合
- **TypeScript**：完整的类型安全，提供全面的接口定义
- **多格式支持**：EPUB 2.x/3.x、MOBI/AZW/AZW3、FictionBook 2、CBZ
- **环境无关的解析器**：所有解析器通过适配器注入，可在浏览器、Node.js 或 Worker 中运行
- **浏览器渲染器**：支持分页和滚动两种阅读模式
- **进度追踪**：支持章节级和目录级的进度报告
- **框架无关**：核心库兼容任意框架；React/Vue 封装计划中

## 安装

```bash
npm install ebook-js
```

## 快速开始

```typescript
import { registry, createReader } from 'ebook-js'
import { epub } from 'ebook-js/parsers/epub'
import { mobi } from 'ebook-js/parsers/mobi'
import { fb2 } from 'ebook-js/parsers/fb2'
import { cbz } from 'ebook-js/parsers/cbz'

// 1. 注册解析器（支持自动检测格式）
registry.register('epub', epub)
registry.register('mobi', mobi)
registry.register('fb2', fb2)
registry.register('cbz', cbz)

// 2. 创建阅读器
const reader = createReader({
    container: document.getElementById('viewer')!,
})

// 3. 打开书籍（File、Blob 或 URL）
const book = await reader.open(file)

// 4. 导航
await reader.next()
await reader.prev()
await reader.goTo('/path/to/chapter.xhtml#section')
```

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                          ebook-js                             │
├────────────────────────────┬─────────────────────────────────┤
│          解析器             │            渲染器               │
│                            │                                 │
│  ┌──────────────────────┐  │  ┌───────────────────────────┐  │
│  │  EPUB 解析器          │  │  │  浏览器渲染器              │  │
│  │  （环境无关）          │  │  │  （分页/滚动）             │  │
│  └──────────┬───────────┘  │  └───────────────────────────┘  │
│             │              │  ┌───────────────────────────┐  │
│  ┌──────────┴───────────┐  │  │  React/Vue 封装           │  │
│  │  适配器（注入式）      │  │  │  （计划中）               │  │
│  │  - DOMAdapter        │  │  └───────────────────────────┘  │
│  │  - URLFactory        │  │                                 │
│  └──────────────────────┘  │                                 │
│                            │                                 │
│         │                  │            ▲                    │
│         ▼                  │            │                    │
│      Book 接口 ─────────────┼────────────┘                    │
│    （通用契约）              │                                 │
└────────────────────────────┴─────────────────────────────────┘
```

### 设计原则

1. **解析器环境无关**：EPUB 解析器不依赖浏览器 API。DOM 解析和 URL 创建通过适配器注入。
2. **渲染器管理浏览器**：浏览器相关逻辑（iframe、CSS 分栏、DOM 事件）统一由渲染器处理。
3. **Book 是契约**：解析器产出 `Book`，渲染器消费 `Book`，双方互不感知。

### 核心接口

#### `Book`（解析器的输出，渲染器的输入）
```typescript
interface Book {
    sections: Section[]        // 有序的章节列表
    dir?: 'ltr' | 'rtl'       // 翻页方向
    toc?: TOCItem[]           // 目录
    metadata?: BookMetadata   // 书名、作者等
    rendition?: Rendition     // 排版提示
    resolveHref?(href): ResolvedNavigation | null
    getCover?(): Promise<Blob | null>
}
```

#### `Section`（单个章节/文档）
```typescript
interface Section {
    id: string | number
    load(): Promise<string>              // 返回内容的 URL（通过 URLFactory）
    unload?(): void                      // 释放资源
    createDocument?(): Promise<string>   // 返回原始 HTML 字符串（用于搜索）
    size: number                         // 字节大小（用于进度计算）
}
```

#### `Parser`（解析器）
```typescript
interface Parser {
    parse(input, options?): Promise<Book>
    canParse(input): Promise<boolean>
}

interface ParserOptions {
    domAdapter?: DOMAdapter    // 注入的 DOM 适配器（EPUB 必需）
    urlFactory?: URLFactory    // 注入的 URL 工厂（EPUB 必需）
    sha1?: (data: ArrayBuffer) => Promise<ArrayBuffer>
    onProgress?: (progress: number, message?: string) => void
}
```

#### `Renderer`（渲染器）
```typescript
interface Renderer {
    open(book): Promise<void>
    goTo(target): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    setStyles(styles): void
    on(event, listener): void
}
```

## 适配器系统

EPUB 解析器使用依赖注入来保持环境无关性。需要通过 `ParserOptions` 提供两个适配器：

### `DOMAdapter`（DOM 适配器）

抽象 DOM 解析和查询操作：

```typescript
interface DOMAdapter {
    parseXML(str: string): XMLDocument
    parseHTML(str: string, mimeType?: string): XMLDocument
    serialize(doc: XMLDocument): string
}
```

### `URLFactory`（URL 工厂）

抽象 Blob URL 的创建：

```typescript
interface URLFactory {
    createURL(data: string | ArrayBuffer, mimeType: string): string
    revokeURL(url: string): void
}
```

### 内置适配器

| 适配器 | 包路径 | 运行环境 |
|--------|--------|----------|
| `BrowserDOMAdapter` | `ebook-js` | 浏览器 |
| `BrowserURLFactory` | `ebook-js` | 浏览器 |
| `TestDOMAdapter` | `ebook-js/adapters/test` | Node.js（使用 @xmldom/xmldom） |
| `TestURLFactory` | `ebook-js/adapters/test` | Node.js（模拟 URL） |

### 浏览器环境（自动注入）

使用 `createReader()` 时，浏览器适配器会自动注入：

```typescript
import { createReader, registry } from 'ebook-js'
import { epub } from 'ebook-js/parsers/epub'

registry.register('epub', epub)
const reader = createReader({ container: element })
// 浏览器适配器自动提供
await reader.open(file)
```

### Node.js / Worker 环境

在浏览器外解析时，需要手动提供适配器：

```typescript
import { registry } from 'ebook-js'
import { epub } from 'ebook-js/parsers/epub'
import { TestDOMAdapter, TestURLFactory } from 'ebook-js/adapters/test'

registry.register('epub', epub)

const domAdapter = new TestDOMAdapter()
const urlFactory = new TestURLFactory()

const book = await registry.open(arrayBuffer, { domAdapter, urlFactory })
```

## 畸形 EPUB 处理

许多 EPUB 文件的 zip 归档存在结构性问题——特别是中央目录（Central Directory）偏移量错误，导致标准 zip 库无法读取条目数据。ebook-js 包含多重回退策略来优雅地处理这些文件：

1. **前缀数据校正** — 检测并修正统一偏移的数据（常见于自解压归档或带有前缀数据的文件），在重试前修补中央目录条目。
2. **逐条目本地文件头扫描** — 当个别条目偏移量错误时，扫描整个文件查找实际的本地文件头（Local File Header）位置，并使用 `DecompressionStream` 直接提取数据。
3. **纯本地文件头回退** — 当中央目录完全不可读时，仅从本地文件头构建条目列表和加载器。
4. **优雅降级** — 无法恢复的条目返回 `null` 而非抛出异常，允许书籍的其余部分正常加载。

这使得 ebook-js 在处理各种制作工具生成的 EPUB 文件时，比原生 `@zip.js/zip.js` 或 foliate-js 等库具有更强的容错能力。

## API 参考

### 解析器注册表

```typescript
import { registry } from 'ebook-js'

// 注册解析器
registry.register('epub', epub)

// 自动检测格式并解析
const book = await registry.open(file, { domAdapter, urlFactory })

// 查看已注册的解析器
registry.list() // ['epub']
```

### ReaderView（高级 API）

```typescript
import { createReader } from 'ebook-js'

const reader = createReader({
    container: element,
    layout: 'paginated', // 或 'scrolled'
    styles: {
        fontFamily: 'Georgia, serif',
        fontSize: '16px',
        lineHeight: 1.6,
        textAlign: 'justify',
        hyphenate: true,
    },
})

// 打开书籍
await reader.open(file)

// 导航
await reader.next()
await reader.prev()
await reader.goLeft()    // 遵循 RTL 方向
await reader.goRight()   // 遵循 RTL 方向
await reader.goTo(href)
await reader.goToFraction(0.5)

// 样式
reader.setStyles({ fontSize: '18px' })
reader.setLayout('scrolled')

// 事件
reader.on('load', (e) => console.log('章节已加载:', e.index))
reader.on('relocate', (e) => console.log('位置:', e))
reader.on('link', (e) => {
    if (e.external) window.open(e.href)
})

// 元数据
const metadata = reader.getMetadata()
const toc = reader.getTOC()
const location = reader.getLocation()
const fractions = reader.getSectionFractions() // 用于进度条刻度

// 清理资源
reader.destroy()
```

### 样式配置

```typescript
interface RendererStyles {
    fontFamily?: string
    fontSize?: string
    lineHeight?: number | string
    textAlign?: 'start' | 'justify' | 'center'
    hyphenate?: boolean
    css?: string           // 自定义 CSS
    theme?: 'light' | 'dark' | 'sepia'
    color?: string
    background?: string
    gap?: string           // 列间距（分页模式）
    maxInlineSize?: string // 最大列宽
    maxBlockSize?: string  // 最大页高
    margin?: string        // 页眉/页脚边距
}
```

## 开发

```bash
# 安装依赖
npm install

# 运行示例
npm run dev

# 类型检查
npm run typecheck

# 构建
npm run build

# 运行测试
npm test

# 监听模式运行测试
npm run test:watch
```

### 项目结构

```
src/
├── core/               # 共享接口和类型
│   ├── types.ts        # Book、Section、TOCItem 等
│   ├── parser.ts       # Parser 接口和注册表
│   ├── renderer.ts     # Renderer 接口
│   ├── dom-adapter.ts  # DOMAdapter 接口
│   └── url-factory.ts  # URLFactory 接口
├── adapters/
│   ├── browser.ts      # 浏览器 DOM/URL 适配器
│   └── test.ts         # Node.js 测试适配器
├── parsers/
│   ├── epub.ts         # EPUB 解析器
│   ├── mobi.ts         # MOBI/AZW/AZW3 解析器
│   ├── fb2.ts          # FictionBook 2 解析器
│   └── cbz.ts          # Comic Book Zip 解析器
├── loaders/
│   └── zip-loader.ts   # Zip 归档加载器
├── renderers/
│   └── browser/        # 浏览器渲染器
│       ├── paginator.ts
│       └── view.ts     # 高级 ReaderView
└── utils/
    └── progress.ts     # 进度追踪

tests/
├── fixtures/           # 测试文件生成器（EPUB、MOBI、FB2、CBZ、zip）
├── loaders/            # Zip 加载器测试（畸形 zip 恢复）
├── parsers/            # 解析器测试（EPUB、MOBI、FB2、CBZ）
└── utils/              # 进度工具测试
```

## 与 foliate-js 的对比

| 特性 | foliate-js | ebook-js |
|------|-----------|----------|
| 语言 | JavaScript | TypeScript |
| 架构 | 单体 view.js | 解析器/渲染器分离 |
| 浏览器耦合 | 解析器使用 DOM API | 解析器环境无关（适配器） |
| 入口方式 | 自定义元素 | 函数式 API |
| 框架支持 | 无 | 计划支持 React/Vue |
| 格式支持 | EPUB、MOBI、FB2、CBZ、PDF | EPUB、MOBI/AZW3、FB2、CBZ |
| 模块系统 | ESM | ESM + 类型导出 |
| 构建工具 | 无（原始 ESM） | Vite + TypeScript |
| 测试 | 无 | Vitest（140 个测试） |
| 畸形 EPUB 容错 | 无（仅 zip.js） | CD 校正 + 逐条目 LFH 扫描 |

## 许可证

MIT

## 致谢

基于 John Factotum 优秀的 [foliate-js](https://github.com/johnfactotum/foliate-js)。
