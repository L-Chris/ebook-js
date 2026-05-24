# rebook

[English](./README.md) | [API 参考](./docs/API.md) | [架构设计](./docs/ARCHITECTURE.md) | [经验总结](./docs/EXPERIENCE.md)

模块化、可扩展的 Web 电子书解析与渲染库。

灵感来自 [foliate-js](https://github.com/johnfactotum/foliate-js)，但对其架构进行了重构——**解析器**（文件格式处理）与**渲染器**（平台相关展示）完全解耦。

## 特性

- **模块化架构**：解析器与渲染器相互独立，可自由组合
- **TypeScript**：完整的类型安全，提供全面的接口定义
- **多格式支持**：EPUB 2.x/3.x、MOBI/AZW/AZW3、FictionBook 2、CBZ
- **AI 友好的文档模型**：受 SlateJS 启发的树形结构，提供查询和修改 API，支持内容操作（翻译、标注、重构）
- **Pretext 排版管线**：EPUB 章节可输出带样式文本片段，支持一次测量、多次纯内存行切片
- **环境无关的解析器**：所有解析器通过适配器注入，可在浏览器、Node.js 或 Worker 中运行
- **可插拔导出器**：通过格式无关的 exporter registry 导出已解析书籍，内置 EPUB 输出
- **浏览器渲染器**：默认使用高性能的 AST/Pretext 虚拟文本渲染器
- **畸形 EPUB 容错**：多层回退策略处理损坏的 zip 归档
- **框架无关**：核心库兼容任意框架；React/Vue 封装计划中

## 安装

```bash
npm install rebook
```

## 支持格式

| 格式 | 扩展名 | 解析器 | 说明 |
|------|--------|--------|------|
| EPUB 2/3 | `.epub` | `EPUBParser` | 完整支持：导航、书脊、字体解密、landmarks |
| Mobipocket / Kindle | `.mobi`、`.azw`、`.azw3` | `MOBIParser` | MOBI6 + KF8、PalmDOC + HUFF/CDIC、EXTH 元数据、NCX |
| FictionBook 2 | `.fb2`、`.fbz`、`.fb2.zip` | `FB2Parser` | FB2 XML 转 XHTML、FBZ 归档支持 |
| Comic Book Zip | `.cbz` | `CBZParser` | 从 zip 归档中读取顺序图片 |

## 快速开始

```typescript
import { registry, createReader, UnsupportedFormatError } from 'rebook'
import { epub } from 'rebook/parsers/epub'
import { mobi } from 'rebook/parsers/mobi'
import { fb2 } from 'rebook/parsers/fb2'
import { cbz } from 'rebook/parsers/cbz'

// 注册解析器（支持自动检测格式）
registry.register('epub', epub)
registry.register('mobi', mobi)
registry.register('fb2', fb2)
registry.register('cbz', cbz)

// 创建阅读器（默认使用虚拟文本渲染器）
const reader = createReader({
    container: document.getElementById('viewer')!,
    styles: {
        fontSize: '18px',
        lineHeight: 1.7,
        maxInlineSize: '720px',
    },
})

// 打开书籍并导航
const book = await reader.open(file)
await reader.next()
await reader.goTo('/path/to/chapter.xhtml#section')
```

### 导出前 N 个 section

```typescript
import { exportFirstSections } from 'rebook'

const blob = await exportFirstSections(file, 5, {
    format: 'epub',
    parserOptions: { domAdapter, urlFactory },
})
```

导出格式通过 `exporterRegistry` 注册，后续新增输出格式不需要改解析器或渲染器。按数量导出使用线性阅读 section：CBZ 的 section 对应图片页，EPUB/MOBI/FB2 对应 spine 或解析器切出的阅读段，不是排版后的视觉页。

### 浏览器渲染

`createReader()` 默认使用 `VirtualTextRenderer`。它会把 XHTML 解析成结构化阅读块（`chapter`、`heading`、`paragraph`、`listItem`、`blockquote`、`pre`），套用适合中英文阅读的预设文本样式，用 Pretext 做测量和行切片，然后只渲染可视区行。

在 `paginated` 布局下，滚轮和 `next()` / `prev()` 会按视口高度翻页，不再自由垂直漂移。宽屏时支持自动双列阅读：当可用宽度能容纳 `2 × maxInlineSize + gap` 时，可视行会分布到左右两列，并保留页内上下留白，避免文字贴到裁切边缘。`reader.setSpread(1)` 强制单列，`reader.setSpread(2)` 恢复自动双列。

## 文档模型（AI 友好）

每个章节暴露一个结构化的文档树，提供查询和修改 API：

```typescript
const section = book.sections[0]
const doc = await section.getDocument()

// CSS 风格的选择器查询
const paragraphs = doc.query('p')
const images = doc.getImages()
const text = doc.getText()

// 不可变修改（返回新文档）
const newDoc = doc
    .setNode([0], { class: 'highlight' })
    .insertNode([1], elementNode('p', {}, [textNode('AI 添加的内容')]))
    .replaceText([0, 0], '翻译后的文本')

// 序列化回 HTML
const html = newDoc.serialize()
```

支持 AI 驱动的工作流：翻译、内容摘要、标注、无障碍增强、布局适配等。详见 [API 参考](./docs/API.md#document-model)。

## Pretext 行布局

需要快速调整样式或做虚拟列表渲染时，可以从 EPUB 章节直接取得结构块和样式片段，先离屏测量一次，再在视口变化或字体缩放时只做内存中的行切片：

```typescript
import { prepareBlocks, layout, getVisibleLines } from 'rebook'

const blocks = await book.sections[0].getBlocks!()
const prepared = prepareBlocks(blocks, {
    baseStyle: { fontSize: 18, lineHeight: 1.6 },
})

const lines = layout(prepared, { inlineSize: 680, lineHeight: 32 })
const visible = getVisibleLines(lines, scrollTop, viewportHeight)
```

`prepare()` 内部使用 `@chenglou/pretext` 做一次性 Canvas 测量，`layout()` 遍历 Pretext 行范围并映射回 EPUB 的 segment/style 来源。输出的 `LineRange` 包含文本片段范围、宽度和行位置，虚拟列表或 Canvas 渲染器可以只渲染可视区内容。

浏览器包也导出了 `VirtualTextRenderer` / `createVirtualTextRenderer`，它基于这条管线只把可视行渲染为简单 DOM spans。

## 文档

- [**API 参考**](./docs/API.md) — 完整 API 文档：解析器、渲染器、适配器、文档模型、Pretext 布局、错误类型、元数据标准化
- [**架构设计**](./docs/ARCHITECTURE.md) — 设计决策、解析器/渲染器分离、适配器系统、跨平台渲染
- [**经验总结**](./docs/EXPERIENCE.md) — AI 友好设计理念、SlateJS 模式借鉴、畸形 EPUB 处理、性能注意事项

## 开发

```bash
npm install       # 安装依赖
npm run dev       # 运行示例
npm run typecheck # 类型检查
npm run build     # 构建
npm test          # 运行测试
```

## 与 foliate-js 的对比

| 特性 | foliate-js | rebook |
|------|-----------|----------|
| 语言 | JavaScript | TypeScript |
| 架构 | 单体 view.js | 解析器/渲染器分离 |
| 浏览器耦合 | 解析器使用 DOM API | 解析器环境无关（适配器） |
| 文档模型 | 无 | SlateJS 启发的树形结构，支持修改 |
| 格式支持 | EPUB、MOBI、FB2、CBZ、PDF | EPUB、MOBI/AZW3、FB2、CBZ |
| 测试 | 无 | Vitest（208 个测试） |
| 畸形 EPUB 容错 | 无（仅 zip.js） | CD 校正 + 逐条目 LFH 扫描 |

## 许可证

MIT

## 致谢

基于 John Factotum 优秀的 [foliate-js](https://github.com/johnfactotum/foliate-js)。
