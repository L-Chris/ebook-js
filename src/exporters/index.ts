import { exporterRegistry } from '../core/exporter'
import { epubExporter } from './epub'

exporterRegistry.register('epub', epubExporter)

export {
    exportBook,
    exportBookAsBuffer,
    exporterRegistry,
    exportFirstPages,
    exportFirstPagesAsBuffer,
    firstPagesSelection,
} from '../core/exporter'
export {
    EPUBExporter,
    epubExporter,
} from './epub'
export type {
    Exporter,
    ExporterFactory,
    ExportOptions,
    ExportFirstPagesOptions,
    ExportFormat,
    ExportPageUnit,
    ExportSelection,
    ExportSelectionType,
} from '../core/exporter'
export {
    selectSections,
} from './section-selection'
export type {
    SelectedSection,
} from './section-selection'
