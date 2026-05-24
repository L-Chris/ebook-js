import { exporterRegistry } from '../core/exporter'
import { epubExporter } from './epub'
import { cbzExporter } from './cbz'
import { txtExporter } from './txt'
import { htmlExporter } from './html'

exporterRegistry.register('epub', epubExporter)
exporterRegistry.register('cbz', cbzExporter)
exporterRegistry.register('txt', txtExporter)
exporterRegistry.register('html', htmlExporter)

export {
    exportBook,
    exportBookAsBuffer,
    exporterRegistry,
    exportFirstSections,
    exportFirstSectionsAsBuffer,
    firstSectionsSelection,
} from '../core/exporter'
export {
    EPUBExporter,
    epubExporter,
} from './epub'
export {
    CBZExporter,
    cbzExporter,
} from './cbz'
export {
    TXTExporter,
    txtExporter,
} from './txt'
export {
    HTMLExporter,
    htmlExporter,
} from './html'
export type {
    Exporter,
    ExporterFactory,
    ExportOptions,
    ExportFirstSectionsOptions,
    ExportFormat,
    ExportSectionUnit,
    ExportSelection,
    ExportSelectionType,
} from '../core/exporter'
export {
    selectSections,
} from './section-selection'
export type {
    SelectedSection,
} from './section-selection'
