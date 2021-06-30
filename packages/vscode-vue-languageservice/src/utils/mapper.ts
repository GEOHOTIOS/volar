import type { Position } from 'vscode-languageserver/node';
import type { Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { CssSourceMap, TeleportMappingData } from '../utils/sourceMaps';
import type { TeleportSideData } from '../utils/sourceMaps';
import type { TsMappingData } from '../utils/sourceMaps';
import type { TsSourceMap } from '../utils/sourceMaps';
import type { LanguageService as TsLanguageService } from 'vscode-typescript-languageservice';
import type { Stylesheet } from 'vscode-css-languageservice';
import type { HTMLDocument } from 'vscode-html-languageservice';
import type { PugDocument } from 'vscode-pug-languageservice';
import type { SourceFile } from '../sourceFile';
import type * as ts2 from 'vscode-typescript-languageservice';
import { fsPathToUri, uriToFsPath } from '@volar/shared';
import { Range as MapedRange } from '@volar/source-map';

export function createMapper(
    sourceFiles: Map<string, SourceFile>,
    getTsLsType: (tsUri: string) => 'template' | 'script',
    getTsLs: (lsType: 'template' | 'script') => ts2.LanguageService,
    getTextDocument: (uri: string) => TextDocument | undefined,
) {
    return {
        css: {
            from: (cssUri: string, cssStart: Position, cssEnd?: Position) => {
                const result: {
                    sourceMap: CssSourceMap,
                    textDocument: TextDocument,
                    range: Range,
                }[] = [];
                for (const [_, sourceFile] of sourceFiles) {
                    for (const sourceMap of sourceFile.getCssSourceMaps()) {
                        if (sourceMap.mappedDocument.uri === cssUri) {
                            for (const vueRange of sourceMap.getSourceRanges(cssStart, cssEnd)) {
                                result.push({
                                    sourceMap: sourceMap,
                                    textDocument: sourceMap.sourceDocument,
                                    range: vueRange,
                                });
                            }
                        }
                    }
                }
                return result;
            },
            to: (vueUri: string, vueStart: Position, vueEnd?: Position) => {
                const result: {
                    sourceMap: CssSourceMap,
                    textDocument: TextDocument,
                    stylesheet: Stylesheet,
                    range: Range,
                }[] = [];
                const sourceFile = sourceFiles.get(vueUri);
                if (sourceFile) {
                    for (const sourceMap of sourceFile.getCssSourceMaps()) {
                        if (!sourceMap.stylesheet) continue;
                        for (const cssRange of sourceMap.getMappedRanges(vueStart, vueEnd)) {
                            result.push({
                                sourceMap: sourceMap,
                                textDocument: sourceMap.mappedDocument,
                                stylesheet: sourceMap.stylesheet,
                                range: cssRange,
                            });
                        }
                    }
                }
                return result;
            },
        },
        html: {
            from: (htmlUri: string, htmlStart: Position, htmlEnd?: Position) => {
                const result: {
                    textDocument: TextDocument,
                    range: Range,
                }[] = [];
                for (const [_, sourceFile] of sourceFiles) {
                    for (const sourceMap of [...sourceFile.getHtmlSourceMaps(), ...sourceFile.getPugSourceMaps()]) {
                        if (sourceMap.mappedDocument.uri === htmlUri) {
                            for (const vueRange of sourceMap.getSourceRanges(htmlStart, htmlEnd)) {
                                result.push({
                                    textDocument: sourceMap.sourceDocument,
                                    range: vueRange,
                                });
                            }
                        }
                    }
                }
                return result;
            },
            to: (vueUri: string, vueStart: Position, vueEnd?: Position) => {
                const result: ({
                    language: 'html',
                    textDocument: TextDocument,
                    htmlDocument: HTMLDocument,
                    range: Range,
                } | {
                    language: 'pug',
                    textDocument: TextDocument,
                    pugDocument: PugDocument,
                    range: Range,
                })[] = [];
                const sourceFile = sourceFiles.get(vueUri);
                if (sourceFile) {
                    for (const sourceMap of sourceFile.getHtmlSourceMaps()) {
                        for (const cssRange of sourceMap.getMappedRanges(vueStart, vueEnd)) {
                            result.push({
                                language: 'html',
                                textDocument: sourceMap.mappedDocument,
                                htmlDocument: sourceMap.htmlDocument,
                                range: cssRange,
                            });
                        }
                    }
                    for (const sourceMap of sourceFile.getPugSourceMaps()) {
                        for (const cssRange of sourceMap.getMappedRanges(vueStart, vueEnd)) {
                            result.push({
                                language: 'pug',
                                textDocument: sourceMap.mappedDocument,
                                pugDocument: sourceMap.pugDocument,
                                range: cssRange,
                            });
                        }
                    }
                }
                return result;
            },
        },
        tsUri: {
            from: (tsUri: string) => {
                const sourceFile = findSourceFileByTsUri(tsUri);
                if (sourceFile) {
                    return sourceFile.getTextDocument();
                }
                const scriptTsLs = getTsLs('script');
                const document = scriptTsLs.__internal__.getTextDocumentUncheck(tsUri);
                if (document) {
                    return document;
                }
            },
        },
        ts: {
            from: fromTs,
            from2: fromTs2,
            to: toTs,
            to2: toTs2,
            teleports,
            teleports2,
        },
        findSourceFileByTsUri,
    };

    function teleports(tsUri: string, tsStart: Position, tsEnd?: Position) {
        const result: {
            data: TeleportMappingData;
            sideData: TeleportSideData;
            start: Position,
            end: Position,
        }[] = [];
        const sourceFile = findSourceFileByTsUri(tsUri);
        if (sourceFile) {
            const teleports = sourceFile.getTeleports();
            for (const teleport of teleports) {
                if (teleport.document.uri === tsUri) {
                    for (const teleRange of teleport.findTeleports(tsStart, tsEnd)) {
                        result.push(teleRange);
                    }
                }
            }
        }
        return result;
    }
    function teleports2(tsFsPath: string, tsStart: number, tsEnd?: number) {
        const result: {
            data: TeleportMappingData;
            sideData: TeleportSideData;
            start: number,
            end: number,
        }[] = [];
        const tsUri = fsPathToUri(tsFsPath);
        const sourceFile = findSourceFileByTsUri(tsUri);
        if (sourceFile) {
            const teleports = sourceFile.getTeleports();
            for (const teleport of teleports) {
                if (teleport.document.uri === tsUri) {
                    for (const teleRange of teleport.findTeleports2(tsStart, tsEnd)) {
                        result.push(teleRange);
                    }
                }
            }
        }
        return result;
    };
    function fromTs(lsType: 'template' | 'script', tsUri: string, tsStart: Position, tsEnd?: Position) {

        const tsLs = getTsLs(lsType);
        const tsDoc = tsLs.__internal__.getTextDocumentUncheck(tsUri);
        if (!tsDoc) return [];

        const _result = fromTs2(
            lsType,
            uriToFsPath(tsUri),
            tsDoc.offsetAt(tsStart),
            tsEnd ? tsDoc.offsetAt(tsEnd) : undefined,
        );

        const result: {
            textDocument: TextDocument,
            range: Range,
            data?: TsMappingData,
        }[] = [];

        for (const r of _result) {
            result.push({
                textDocument: r.textDocument,
                range: {
                    start: r.textDocument.positionAt(r.range.start),
                    end: r.textDocument.positionAt(r.range.end),
                },
                data: r.data,
            });
        }

        return result;
    };
    function fromTs2(lsType: 'template' | 'script', tsFsPath: string, tsStart: number, tsEnd?: number) {
        tsEnd = tsEnd ?? tsStart;

        const tsLs = getTsLs(lsType);
        const result: {
            fileName: string,
            textDocument: TextDocument,
            range: MapedRange,
            data?: TsMappingData,
        }[] = [];
        const tsUri = fsPathToUri(tsFsPath);

        const document = tsLs.__internal__.getTextDocumentUncheck(tsUri);
        if (!document) return [];

        const sourceFile = findSourceFileByTsUri(tsUri);
        if (!sourceFile) {
            result.push({
                fileName: tsFsPath,
                textDocument: document,
                range: {
                    start: tsStart,
                    end: tsEnd,
                },
            });
            return result;
        }

        for (const sourceMap of sourceFile.getTsSourceMaps()) {

            if (sourceMap.lsType !== lsType) continue;
            if (sourceMap.mappedDocument.uri !== tsUri) continue;

            for (const vueRange of sourceMap.getSourceRanges2(tsStart, tsEnd)) {
                result.push({
                    fileName: uriToFsPath(sourceMap.sourceDocument.uri),
                    textDocument: sourceMap.sourceDocument,
                    range: vueRange,
                    data: vueRange.data,
                });
            }
        }

        return result;
    };
    function toTs(lsType: 'template' | 'script', vueUri: string, vueStart: Position, vueEnd?: Position) {

        const vueDoc = getTextDocument(vueUri);
        if (!vueDoc) return [];

        const result_2 = toTs2(
            lsType,
            uriToFsPath(vueUri),
            vueDoc.offsetAt(vueStart),
            vueEnd ? vueDoc.offsetAt(vueEnd) : undefined,
        );
        const result: {
            sourceMap: TsSourceMap | undefined,
            textDocument: TextDocument,
            range: Range,
            data: TsMappingData,
            languageService: TsLanguageService,
        }[] = [];

        for (const r of result_2) {
            result.push({
                sourceMap: r.sourceMap,
                textDocument: r.textDocument,
                range: {
                    start: r.textDocument.positionAt(r.range.start),
                    end: r.textDocument.positionAt(r.range.end),
                },
                data: r.data,
                languageService: getTsLs(lsType),
            });
        }

        return result;
    }
    function toTs2(lsType: 'template' | 'script', vueFsPath: string, vueStart: number, vueEnd?: number) {
        vueEnd = vueEnd ?? vueStart;

        const result: {
            sourceMap: TsSourceMap | undefined,
            fileName: string,
            textDocument: TextDocument,
            range: MapedRange,
            data: TsMappingData,
        }[] = [];
        const sourceFile = sourceFiles.get(fsPathToUri(vueFsPath));
        if (sourceFile) {
            if (lsType === 'template') {
                for (const sourceMap of sourceFile.getTsSourceMaps()) {
                    for (const tsRange of sourceMap.getMappedRanges2(vueStart, vueEnd)) {
                        result.push({
                            sourceMap: sourceMap,
                            fileName: uriToFsPath(sourceMap.mappedDocument.uri),
                            textDocument: sourceMap.mappedDocument,
                            range: tsRange,
                            data: tsRange.data,
                        });
                    }
                }
            }
            else {
                const scriptSourceMap = sourceFile.getScriptLsSourceMap();
                if (scriptSourceMap) {
                    for (const tsRange of scriptSourceMap.getMappedRanges2(vueStart, vueEnd)) {
                        result.push({
                            sourceMap: scriptSourceMap,
                            fileName: uriToFsPath(scriptSourceMap.mappedDocument.uri),
                            textDocument: scriptSourceMap.mappedDocument,
                            range: tsRange,
                            data: tsRange.data,
                        });
                    }
                }
            }
        }
        else {
            const tsDoc = getTsLs(lsType).__internal__.getTextDocumentUncheck(fsPathToUri(vueFsPath));
            if (tsDoc) {
                result.push({
                    sourceMap: undefined,
                    fileName: uriToFsPath(tsDoc.uri),
                    textDocument: tsDoc,
                    range: {
                        start: vueStart,
                        end: vueEnd,
                    },
                    data: {
                        vueTag: 'script',
                        capabilities: {
                            basic: true,
                            references: true,
                            definitions: true,
                            diagnostic: true,
                            formatting: true,
                            rename: true,
                            completion: true,
                            semanticTokens: true,
                            foldingRanges: true,
                            referencesCodeLens: true,
                        },
                    },
                });
            }
        }
        return result;
    };
    function findSourceFileByTsUri(tsUri: string) {
        for (const sourceFile of sourceFiles.values()) {
            if (sourceFile.getTemplateLsDocs().has(tsUri)) {
                return sourceFile;
            }
            else if (sourceFile.getScriptLsDoc()?.uri === tsUri) {
                return sourceFile;
            }
        }
        return undefined;
    }
}
