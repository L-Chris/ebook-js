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

## 支持格式

| 格式 | 扩展名 | 解析器 | 说明 |
|------|--------|--------|------|
| EPUB 2/3 | `.epub` | `EPUBParser` | 完整支持：导航、书脊、字体解密、landmarks |
| Mobipocket / Kindle | `.mobi`、`.azw`、`.azw3` | `MOBIParser` | MOBI6 + KF8、PalmDOC + HUFF/CDIC、EXTH 元数据、NCX |
| FictionBook 2 | `.fb2`、`.fbz`、`.fb2.zip` | `FB2Parser` | FB2 XML 转 XHTML、FBZ 归档支持（渲染时使用 `fb2DefaultStyles`） |
| Comic Book Zip | `.cbz` | `CBZParser` | 从 zip 归档中读取顺序图片 |

## 快速开始

```typescript
import {
    registry,
    createReader,
    BrowserDOMAdapter,
    BrowserURLFactory,
    UnsupportedFormatError,
} from 'ebook-js'
import { epub } from 'ebook-js/parsers/epub'
import { mobi } from 'ebook-js/parsers/mobi'
import { fb2 } from 'ebook-js/parsers/fb2'
import { cbz } from 'ebook-js/parsers/cbz'

// 1. 注册解析器（支持自动检测格式，优先级自动设置）
registry.register('epub', epub)
registry.register('mobi', mobi)
registry.register('fb2', fb2)
registry.register('cbz', cbz)

// 2. 创建阅读器（浏览器环境下适配器自动注入）
const reader = createReader({
    container: document.getElementById('viewer')!,
})

// 3. 打开书籍（File、Blob 或 URL）
try {
    const book = await reader.open(file)

    // 4. 导航
    await reader.next()
    await reader.prev()
    await reader.goTo('/path/to/chapter.xhtml#section')
} catch (e) {
    if (e instanceof UnsupportedFormatError) {
        alert('不支持的文件格式')
    } else {
        throw e
    }
}
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
    priority?: number    // 检测优先级（越高越优先，默认 0）
}

interface ParserOptions {
    domAdapter?: DOMAdapter    // 注入的 DOM 适配器（所有解析器必需）
    urlFactory?: URLFactory    // 注入的 URL 工厂（所有解析器必需）
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
    createURL(data: string | ArrayBuffer | Blob, mimeType?: string): string
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

## 错误处理

ebook-js 提供了类型化的错误层次结构，便于更好的错误处理：

```typescript
import {
    EBookError,            // 所有 ebook-js 错误的基类
    ParseError,            // 解析失败（内容格式错误）
    UnsupportedFormatError, // 格式无法识别
    CorruptedFileError,    // 文件严重损坏
    AdapterRequiredError,  // 未提供必需的适配器
    UnsupportedInputError, // 不支持的输入类型
} from 'ebook-js'

try {
    const book = await registry.open(file, { domAdapter, urlFactory })
} catch (e) {
    if (e instanceof UnsupportedFormatError) {
        console.error('请打开 EPUB、MOBI、FB2 或 CBZ 文件。')
    } else if (e instanceof AdapterRequiredError) {
        console.error('请在选项中提供 domAdapter 和 urlFactory。')
    } else if (e instanceof ParseError) {
        console.error(`解析错误 (${e.format}): ${e.message}`)
    } else if (e instanceof CorruptedFileError) {
        console.error(`文件损坏 (${e.format}): ${e.message}`)
    } else if (e instanceof EBookError) {
        console.error(`错误 [${e.code}]: ${e.message}`)
    } else {
        throw e // 重新抛出非预期错误
    }
}
```

所有错误都有：
- `message`：人类可读的错误描述
- `code`：机器可读的错误代码（如 `'PARSE_ERROR'`）
- `name`：错误类名

格式相关的错误还有 `format` 属性（如 `'epub'`、`'mobi'`）。

## 解析器检测优先级

使用自动检测（`registry.open()` 或 `registry.detect()`）时，解析器按优先级顺序检查（从高到低）。每个解析器有默认优先级：

| 解析器 | 优先级 | 说明 |
|--------|--------|------|
| EPUB | 10 | 最先检查——格式检测最具体 |
| MOBI | 5 | 检查 BOOKMOBI 魔数 |
| FB2 | 5 | 检查 FictionBook XML 或 zip 中的 .fb2 |
| CBZ | 0 | 最后检查——带图片的通用 zip |

可以在注册时覆盖优先级：

```typescript
// 为你的场景给 CBZ 更高优先级
registry.register('cbz', cbz, 20)
```

## 元数据标准化

所有解析器将元数据标准化为一致的类型，使得消费者无需处理格式差异：

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | `string` | 始终为纯字符串 |
| `subtitle` | `string` | 始终为纯字符串 |
| `author` | `Contributor[]` | 始终为 `{ name, sortAs?, role? }` 对象数组 |
| `translator` | `Contributor[]` | 始终为数组 |
| `editor` | `Contributor[]` | 始终为数组 |
| `publisher` | `string` | 始终为纯字符串 |
| `language` | `string` | 始终为单个字符串（多个语言时取第一个） |
| `subject` | `string[]` | 始终为字符串数组 |
| `identifier` | `string` | 纯字符串 |
| `published` | `string` | 纯字符串（日期） |
| `modified` | `string` | 纯字符串（日期） |
| `description` | `string` | 纯字符串（可能包含 HTML） |

### 访问元数据

```typescript
const book = await registry.open(file, options)

// title 始终是字符串
console.log(book.metadata?.title) // "我的书"

// author 始终是 Contributor 对象数组
const authors = book.metadata?.author ?? []
for (const author of authors) {
    console.log(author.name) // "张三"
    if (author.sortAs) console.log(author.sortAs) // "Zhang, San"
}

// publisher 始终是字符串
console.log(book.metadata?.publisher) // "出版社"

// language 始终是字符串（多个语言时取第一个）
console.log(book.metadata?.language) // "zh-CN"
```

### 标准化辅助函数

对于高级用例，导出了标准化辅助函数：

```typescript
import {
    normalizeLanguage,
    normalizeTitle,
    normalizePublisher,
    normalizeContributors,
    normalizeSubjects,
} from 'ebook-js'
```

## FB2 样式

与 EPUB 和 MOBI 不同，FB2 是纯 XML 格式，不包含样式信息。解析器将 FB2 转换为干净的 XHTML，不嵌入任何 CSS。

要为 FB2 内容应用正确的样式，使用导出的默认样式表：

```typescript
import { fb2DefaultStyles } from 'ebook-js'

// 将默认 FB2 样式应用到渲染器
reader.setStyles({ css: fb2DefaultStyles })
```

你也可以自定义或替换样式：

```typescript
// 使用自定义 FB2 样式
reader.setStyles({ css: `
    .title h1 { text-align: center; font-size: 1.5em; }
    p { text-indent: 1.5em; }
    .stanza { margin: 2em 0; }
` })

// 或结合默认样式与自定义覆盖
reader.setStyles({ css: fb2DefaultStyles + `
    p { color: #333; }
` })
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
