import { exporterRegistry } from '../core/exporter'
import { epubExporter } from './epub'

exporterRegistry.register('epub', epubExporter)

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
