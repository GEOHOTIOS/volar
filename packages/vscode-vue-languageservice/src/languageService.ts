import { TextDocument, Position } from 'vscode-languageserver-textdocument';
import { uriToFsPath, fsPathToUri } from '@volar/shared';
import { createSourceFile, SourceFile } from './sourceFile';
import { getGlobalDoc } from './virtuals/global';
import { pauseTracking, resetTracking } from '@vue/reactivity';
import * as upath from 'upath';
import type * as ts from 'typescript';
import { DocumentContext, HTMLDocument } from 'vscode-html-languageservice';
import { HtmlLanguageServiceContext, ApiLanguageServiceContext } from './types';
import { createMapper } from './utils/mapper';
import * as tsPluginApis from './tsPluginApis';
// import * as tsProgramApis from './tsProgramApis';
// vue services
import * as completions from './services/completion';
import * as completionResolve from './services/completionResolve';
import * as autoClose from './services/autoClose';
import * as refAutoClose from './services/refAutoClose';
import * as hover from './services/hover';
import * as diagnostics from './services/diagnostics';
import * as formatting from './services/formatting';
import * as definitions from './services/definition';
import * as references from './services/references';
import * as rename from './services/rename';
import * as codeActions from './services/codeAction';
import * as codeActionResolve from './services/codeActionResolve';
import * as documentHighlight from './services/documentHighlight';
import * as documentSymbol from './services/documentSymbol';
import * as documentLink from './services/documentLinks';
import * as documentColor from './services/documentColor';
import * as selectionRanges from './services/selectionRanges';
import * as signatureHelp from './services/signatureHelp';
import * as colorPresentations from './services/colorPresentation';
import * as semanticTokens from './services/semanticTokens';
import * as foldingRanges from './services/foldingRanges';
import * as codeLens from './services/codeLens';
import * as codeLensResolve from './services/codeLensResolve';
import * as executeCommand from './services/executeCommand';
import * as callHierarchy from './services/callHierarchy';
import * as linkedEditingRanges from './services/linkedEditingRange';
import * as tagNameCase from './services/tagNameCase';
import * as d3 from './services/d3';
import { UriMap } from '@volar/shared';
import type * as emmet from 'vscode-emmet-helper';
// context
import * as fs from 'fs';
import * as css from 'vscode-css-languageservice';
import * as html from 'vscode-html-languageservice';
import * as json from 'vscode-json-languageservice';
import * as pug from 'vscode-pug-languageservice';
import * as ts2 from 'vscode-typescript-languageservice';

export type DocumentLanguageService = ReturnType<typeof getDocumentLanguageService>;
export type LanguageService = ReturnType<typeof createLanguageService>;
export type LanguageServiceHost = ts.LanguageServiceHost & {
	getEmmetConfig?: (syntax: string) => Promise<emmet.VSCodeEmmetConfig> | emmet.VSCodeEmmetConfig,
	schemaRequestService?: json.SchemaRequestService,
};
export type Dependencies = {
	typescript: typeof import('typescript/lib/tsserverlibrary'),
	// TODO: vscode-html-languageservice
	// TODO: vscode-css-languageservice
};

export function getDocumentLanguageService({ typescript: ts }: Dependencies) {
	const cache = new Map<string, [number, HTMLDocument]>();
	const context: HtmlLanguageServiceContext = {
		...createContext(ts),
		getHtmlDocument,
	};
	return {
		doFormatting: formatting.register(context),
		getFoldingRanges: foldingRanges.register(context),
		doTagComplete: autoClose.register(context),
		findLinkedEditingRanges: linkedEditingRanges.register(context),
	}
	function getHtmlDocument(document: TextDocument) {
		const _cache = cache.get(document.uri);
		if (_cache) {
			const [cacheVersion, cacheHtmlDoc] = _cache;
			if (cacheVersion === document.version) {
				return cacheHtmlDoc;
			}
		}
		const htmlDoc = context.htmlLs.parseHTMLDocument(document);
		cache.set(document.uri, [document.version, htmlDoc]);
		return htmlDoc;
	}
}
export function createLanguageService(
	{ typescript: ts }: Dependencies,
	vueHost: LanguageServiceHost,
	isTsPlugin = false,
) {

	let vueProjectVersion: string | undefined;
	let lastScriptVersions = new Map<string, string>();
	let tsProjectVersion = 0;
	let tsProjectVersionWithoutTemplate = 0;
	let lastCompletionUpdateVersion = -1;
	const documents = new UriMap<TextDocument>();
	const sourceFiles = new UriMap<SourceFile>();
	const templateScriptUpdateUris = new Set<string>();
	const initProgressCallback: ((p: number) => void)[] = [];

	const templateTsLsHost = createTsLsHost('template');
	const scriptTsLsHost = createTsLsHost('script');
	const templateTsLs = ts2.createLanguageService(templateTsLsHost, ts);
	const scriptTsLs = ts2.createLanguageService(scriptTsLsHost, ts);
	const globalDoc = getGlobalDoc(vueHost.getCurrentDirectory());
	const compilerHost = ts.createCompilerHost(vueHost.getCompilationSettings());
	const documentContext: DocumentContext = {
		resolveReference(ref: string, base: string) {

			const resolveResult = ts.resolveModuleName(ref, base, vueHost.getCompilationSettings(), compilerHost);
			const failedLookupLocations: string[] = (resolveResult as any).failedLookupLocations;
			const dirs = new Set<string>();

			for (const failed of failedLookupLocations) {
				let path = failed;
				if (path.endsWith('index.d.ts')) {
					dirs.add(path.substr(0, path.length - '/index.d.ts'.length));
				}
				if (path.endsWith('.d.ts')) {
					path = upath.trimExt(path);
					path = upath.trimExt(path);
				}
				else {
					path = upath.trimExt(path);
				}
				if (ts.sys.fileExists(path) || ts.sys.fileExists(uriToFsPath(path))) {
					return path;
				}
			}
			for (const dir of dirs) {
				if (ts.sys.directoryExists(dir) || ts.sys.directoryExists(uriToFsPath(dir))) {
					return dir;
				}
			}

			return undefined;
		},
	}

	const context: ApiLanguageServiceContext = {
		...createContext(ts, vueHost),
		vueHost,
		sourceFiles,
		templateTsLs,
		scriptTsLs,
		mapper: createMapper(sourceFiles, getTsLs, getTextDocument),
		documentContext,
		getTsLs,
	};
	const _callHierarchy = callHierarchy.register(context);
	const findDefinition = definitions.register(context);
	const renames = rename.register(context);

	// ts plugin proxy
	const _tsPluginApis = tsPluginApis.register(context);
	const tsPlugin: Partial<ts.LanguageService> = {
		getSemanticDiagnostics: apiHook((...args: Parameters<ts.LanguageService['getSemanticDiagnostics']>) => context.getTsLs(fsPathToUri(args[0])).__internal__.raw.getSemanticDiagnostics(...args), false),
		getEncodedSemanticClassifications: apiHook((...args: Parameters<ts.LanguageService['getEncodedSemanticClassifications']>) => context.getTsLs(fsPathToUri(args[0])).__internal__.raw.getEncodedSemanticClassifications(...args), false),
		getCompletionsAtPosition: apiHook((...args: Parameters<ts.LanguageService['getCompletionsAtPosition']>) => context.getTsLs(fsPathToUri(args[0])).__internal__.raw.getCompletionsAtPosition(...args), false),
		getCompletionEntryDetails: apiHook((...args: Parameters<ts.LanguageService['getCompletionEntryDetails']>) => context.getTsLs(fsPathToUri(args[0])).__internal__.raw.getCompletionEntryDetails(...args), false),
		getCompletionEntrySymbol: apiHook((...args: Parameters<ts.LanguageService['getCompletionEntrySymbol']>) => context.getTsLs(fsPathToUri(args[0])).__internal__.raw.getCompletionEntrySymbol(...args), false),
		getSignatureHelpItems: apiHook((...args: Parameters<ts.LanguageService['getSignatureHelpItems']>) => context.getTsLs(fsPathToUri(args[0])).__internal__.raw.getSignatureHelpItems(...args), false),
		getRenameInfo: apiHook((...args: Parameters<ts.LanguageService['getRenameInfo']>) => context.getTsLs(fsPathToUri(args[0])).__internal__.raw.getRenameInfo(...args), false),

		findRenameLocations: apiHook(_tsPluginApis.findRenameLocations, true),
		getDefinitionAtPosition: apiHook(_tsPluginApis.getDefinitionAtPosition, false),
		getDefinitionAndBoundSpan: apiHook(_tsPluginApis.getDefinitionAndBoundSpan, false),
		getTypeDefinitionAtPosition: apiHook(_tsPluginApis.getTypeDefinitionAtPosition, false),
		getImplementationAtPosition: apiHook(_tsPluginApis.getImplementationAtPosition, false),
		getReferencesAtPosition: apiHook(_tsPluginApis.getReferencesAtPosition, true),
		findReferences: apiHook(_tsPluginApis.findReferences, true),

		// TODO: now is handle by vue server
		// prepareCallHierarchy: apiHook(tsLanguageService.rawLs.prepareCallHierarchy, false),
		// provideCallHierarchyIncomingCalls: apiHook(tsLanguageService.rawLs.provideCallHierarchyIncomingCalls, false),
		// provideCallHierarchyOutgoingCalls: apiHook(tsLanguageService.rawLs.provideCallHierarchyOutgoingCalls, false),
		// getEditsForFileRename: apiHook(tsLanguageService.rawLs.getEditsForFileRename, false),

		// TODO
		// getCodeFixesAtPosition: apiHook(tsLanguageService.rawLs.getCodeFixesAtPosition, false),
		// getCombinedCodeFix: apiHook(tsLanguageService.rawLs.getCombinedCodeFix, false),
		// applyCodeActionCommand: apiHook(tsLanguageService.rawLs.applyCodeActionCommand, false),
		// getApplicableRefactors: apiHook(tsLanguageService.rawLs.getApplicableRefactors, false),
		// getEditsForRefactor: apiHook(tsLanguageService.rawLs.getEditsForRefactor, false),
	};

	// ts program proxy
	// const tsProgram = tsLs.__internal__.raw.getProgram();
	// if (!tsProgram) throw '!tsProgram';

	// const tsProgramApis_2 = tsProgramApis.register(context);
	// const tsProgramApis_3: Partial<typeof tsProgram> = {
	// 	emit: apiHook(tsProgramApis_2.emit),
	// 	getRootFileNames: apiHook(tsProgramApis_2.getRootFileNames),
	// 	getSemanticDiagnostics: apiHook(tsProgramApis_2.getSemanticDiagnostics),
	// 	getSyntacticDiagnostics: apiHook(tsProgramApis_2.getSyntacticDiagnostics),
	// 	getGlobalDiagnostics: apiHook(tsProgramApis_2.getGlobalDiagnostics),
	// };
	// const tsProgramProxy = new Proxy(tsProgram, {
	// 	get: (target: any, property: keyof typeof tsProgram) => {
	// 		return tsProgramApis_3[property] || target[property];
	// 	},
	// });

	return {
		doValidation: apiHook(diagnostics.register(context)),
		findDefinition: apiHook(findDefinition.on),
		findReferences: apiHook(references.register(context)),
		findTypeDefinition: apiHook(findDefinition.onType),
		callHierarchy: {
			doPrepare: apiHook(_callHierarchy.doPrepare),
			getIncomingCalls: apiHook(_callHierarchy.getIncomingCalls),
			getOutgoingCalls: apiHook(_callHierarchy.getOutgoingCalls),
		},
		prepareRename: apiHook(renames.prepareRename),
		doRename: apiHook(renames.doRename),
		getEditsForFileRename: apiHook(renames.onRenameFile, false),
		getSemanticTokens: apiHook(semanticTokens.register(context)),

		doHover: apiHook(hover.register(context), getShouldUpdateTemplateScript),
		doComplete: apiHook(completions.register(context), getShouldUpdateTemplateScript),

		getCodeActions: apiHook(codeActions.register(context), false),
		doCodeActionResolve: apiHook(codeActionResolve.register(context), false),
		doCompletionResolve: apiHook(completionResolve.register(context), false),
		doCodeLensResolve: apiHook(codeLensResolve.register(context), false),
		getSignatureHelp: apiHook(signatureHelp.register(context), false),
		getSelectionRanges: apiHook(selectionRanges.register(context), false),
		getColorPresentations: apiHook(colorPresentations.register(context), false),
		getCodeLens: apiHook(codeLens.register(context), false),
		findDocumentHighlights: apiHook(documentHighlight.register(context), false),
		findDocumentSymbols: apiHook(documentSymbol.register(context), false),
		findDocumentLinks: apiHook(documentLink.register(context), false),
		findDocumentColors: apiHook(documentColor.register(context), false),
		dispose: () => {
			templateTsLs.dispose();
		},

		__internal__: {
			rootPath: vueHost.getCurrentDirectory(),
			tsPlugin,
			// tsProgramProxy,
			onInitProgress(cb: (p: number) => void) {
				initProgressCallback.push(cb);
			},
			getTextDocument,
			checkProject: apiHook(() => {
				const vueImportErrors = templateTsLs.doValidation(globalDoc.uri, { semantic: true });
				return !vueImportErrors.find(error => error.code === 2322); // Type 'false' is not assignable to type 'true'.ts(2322)
			}),
			getTemplateTsLs: () => templateTsLs,
			getGlobalDoc: () => globalDoc,
			getSourceFile: apiHook(getSourceFile),
			getAllSourceFiles: apiHook(getAllSourceFiles),
			getD3: apiHook(d3.register(context)),
			executeCommand: apiHook(executeCommand.register(context, references.register(context))),
			detectTagNameCase: apiHook(tagNameCase.register(context)),
			doRefAutoClose: apiHook(refAutoClose.register(context), false),
		},
	};

	function getTsLs(tsUri: string | 'template' | 'script') {
		if (tsUri === 'template') return templateTsLs;
		if (tsUri === 'script') return scriptTsLs;
		// TODO: return multiple
		if (scriptTsLs.__internal__.getTextDocumentUncheck(tsUri)) {
			return scriptTsLs;
		}
		if (templateTsLs.__internal__.getTextDocumentUncheck(tsUri)) {
			return templateTsLs;
		}
		return scriptTsLs;
	}
	function getShouldUpdateTemplateScript(uri: string, pos: Position) {

		if (!isInTemplate()) {
			return false;
		}

		update(false); // update tsProjectVersionWithoutTemplate
		if (lastCompletionUpdateVersion !== tsProjectVersionWithoutTemplate) {
			lastCompletionUpdateVersion = tsProjectVersionWithoutTemplate;
			return true;
		}

		return false;

		function isInTemplate() {
			const tsRanges = context.mapper.ts.to(uri, pos);
			for (const tsRange of tsRanges) {
				if (tsRange.data.vueTag === 'template') {
					return true;
				}
			}
			const htmlRanges = context.mapper.html.to(uri, pos);
			if (htmlRanges.length) {
				return true;
			}
			return false;
		}
	}
	function apiHook<T extends (...args: any) => any>(api: T, shouldUpdateTemplateScript: boolean | ((...args: Parameters<T>) => boolean) = true) {
		const handler = {
			apply: function (target: (...args: any) => any, thisArg: any, argumentsList: Parameters<T>) {
				if (typeof shouldUpdateTemplateScript === 'boolean') {
					update(shouldUpdateTemplateScript);
				}
				else {
					update(shouldUpdateTemplateScript.apply(null, argumentsList));
				}
				return target.apply(thisArg, argumentsList);
			}
		};
		return new Proxy<T>(api, handler);
	}
	function update(shouldUpdateTemplateScript: boolean) {
		const newVueProjectVersion = vueHost.getProjectVersion?.();
		if (newVueProjectVersion === undefined || newVueProjectVersion !== vueProjectVersion) {

			let tsFileChanged = false;
			vueProjectVersion = newVueProjectVersion;
			const oldFiles = new Set([...lastScriptVersions.keys()]);
			const newFiles = new Set([...vueHost.getScriptFileNames()]);
			const removes: string[] = [];
			const adds: string[] = [];
			const updates: string[] = [];

			for (const fileName of oldFiles) {
				if (!newFiles.has(fileName)) {
					if (fileName.endsWith('.vue')) {
						removes.push(fileName);
					}
					else {
						tsFileChanged = true;
					}
					lastScriptVersions.delete(fileName);
				}
			}
			for (const fileName of newFiles) {
				if (!oldFiles.has(fileName)) {
					if (fileName.endsWith('.vue')) {
						adds.push(fileName);
					}
					else {
						tsFileChanged = true;
					}
					lastScriptVersions.set(fileName, vueHost.getScriptVersion(fileName));
				}
			}
			for (const fileName of oldFiles) {
				if (newFiles.has(fileName)) {
					const oldVersion = lastScriptVersions.get(fileName);
					const newVersion = vueHost.getScriptVersion(fileName);
					if (oldVersion !== newVersion) {
						if (fileName.endsWith('.vue')) {
							updates.push(fileName);
						}
						else {
							tsFileChanged = true;
						}
						lastScriptVersions.set(fileName, newVersion);
					}
				}
			}

			if (tsFileChanged) {
				updateTsProject(false);
				updates.length = 0;
				for (const fileName of oldFiles) {
					if (newFiles.has(fileName)) {
						if (fileName.endsWith('.vue')) {
							updates.push(fileName);
						}
					}
				}
			}

			const finalUpdates = adds.concat(updates);

			if (removes.length) {
				unsetSourceFiles(removes.map(fsPathToUri));
			}
			if (finalUpdates.length) {
				updateSourceFiles(finalUpdates.map(fsPathToUri), shouldUpdateTemplateScript)
			}
		}
		else if (shouldUpdateTemplateScript && templateScriptUpdateUris.size) {
			updateSourceFiles([], shouldUpdateTemplateScript)
		}
	}
	function createTsLsHost(lsType: 'template' | 'script') {
		const scriptSnapshots = new Map<string, [string, ts.IScriptSnapshot]>();
		const tsHost: ts2.LanguageServiceHost = {
			...vueHost,
			fileExists: vueHost.fileExists
				? fileName => {
					const fileNameTrim = upath.trimExt(fileName);
					if (fileNameTrim.endsWith('.vue')) {
						const isHostFile = vueHost.getScriptFileNames().includes(fileNameTrim);
						const fileExists = !!vueHost.fileExists?.(fileNameTrim);
						if (!isHostFile && fileExists) {
							vueProjectVersion += '-old'; // force update
							update(false); // create virtual files
						}
						return fileExists;
					}
					else {
						return !!vueHost.fileExists?.(fileName);
					}
				}
				: undefined,
			getProjectVersion: () => {
				pauseTracking();
				const version = vueHost.getProjectVersion?.() + ':' + tsProjectVersion.toString();
				resetTracking();
				return version;
			},
			getScriptFileNames,
			getScriptVersion,
			getScriptSnapshot,
			readDirectory: (path, extensions, exclude, include, depth) => {
				const result = vueHost.readDirectory?.(path, extensions, exclude, include, depth) ?? [];
				for (const [_, sourceFile] of sourceFiles) {
					const vuePath = uriToFsPath(sourceFile.uri);
					const vuePath2 = upath.join(path, upath.basename(vuePath));
					if (upath.relative(path.toLowerCase(), vuePath.toLowerCase()).startsWith('..')) {
						continue;
					}
					if (!depth && vuePath.toLowerCase() === vuePath2.toLowerCase()) {
						result.push(vuePath2);
					}
					else if (depth) {
						result.push(vuePath2); // TODO: depth num
					}
				}
				return result;
			},
			getScriptKind(fileName) {
				switch (upath.extname(fileName)) {
					case '.vue': return ts.ScriptKind.TSX; // can't use External, Unknown
					case '.js': return ts.ScriptKind.JS;
					case '.jsx': return ts.ScriptKind.JSX;
					case '.ts': return ts.ScriptKind.TS;
					case '.tsx': return ts.ScriptKind.TSX;
					case '.json': return ts.ScriptKind.JSON;
					default: return ts.ScriptKind.Unknown;
				}
			},
		};

		return tsHost;

		function getScriptFileNames() {
			const tsFileNames: string[] = [];
			tsFileNames.push(uriToFsPath(globalDoc.uri));
			for (const fileName of vueHost.getScriptFileNames()) {
				const uri = fsPathToUri(fileName);
				const sourceFile = sourceFiles.get(uri);
				if (sourceFile) {
					if (lsType === 'template') {
						for (const [uri] of sourceFile.getTemplateLsDocs()) {
							tsFileNames.push(uriToFsPath(uri)); // virtual .ts
						}
					}
					else {
						const doc = sourceFile.getScriptLsDoc();
						if (doc) {
							tsFileNames.push(uriToFsPath(doc.uri)); // virtual .ts
						}
					}
				}
				if (isTsPlugin) {
					tsFileNames.push(fileName); // .vue + .ts
				}
				else if (!fileName.endsWith('.vue')) {
					tsFileNames.push(fileName); // .ts
				}
			}
			return tsFileNames;
		}
		function getScriptVersion(fileName: string) {
			const uri = fsPathToUri(fileName);
			if (uri === globalDoc.uri) {
				return globalDoc.version.toString();
			}
			// TODO: perf
			if (lsType === 'template') {
				for (const [_, sourceFile] of sourceFiles) {
					const doc = sourceFile.getTemplateLsDocs().get(uri);
					if (doc) {
						return doc.version.toString();
					}
				}
			}
			else {
				// TODO
				for (const [_, sourceFile] of sourceFiles) {
					const doc = sourceFile.getScriptLsDoc();
					if (doc) {
						return doc.version.toString();
					}
				}
			}
			return vueHost.getScriptVersion(fileName);
		}
		function getScriptSnapshot(fileName: string) {
			const version = getScriptVersion(fileName);
			const cache = scriptSnapshots.get(fileName);
			if (cache && cache[0] === version) {
				return cache[1];
			}
			const uri = fsPathToUri(fileName);
			if (uri === globalDoc.uri) {
				const text = globalDoc.getText();
				const snapshot = ts.ScriptSnapshot.fromString(text);
				scriptSnapshots.set(fileName, [version, snapshot]);
				return snapshot;
			}
			if (lsType === 'template') {
				for (const [_, sourceFile] of sourceFiles) {
					const doc = sourceFile.getTemplateLsDocs().get(uri);
					if (doc) {
						const text = doc.getText();
						const snapshot = ts.ScriptSnapshot.fromString(text);
						scriptSnapshots.set(fileName, [version, snapshot]);
						return snapshot;
					}
				}
			}
			else {
				// TODO
				for (const [_, sourceFile] of sourceFiles) {
					const doc = sourceFile.getScriptLsDoc();
					if (doc) {
						const text = doc.getText();
						const snapshot = ts.ScriptSnapshot.fromString(text);
						scriptSnapshots.set(fileName, [version, snapshot]);
						return snapshot;
					}
				}
			}
			let tsScript = vueHost.getScriptSnapshot(fileName);
			if (tsScript) {
				scriptSnapshots.set(fileName, [version, tsScript]);
				return tsScript;
			}
		}
	}
	function getTextDocument(uri: string): TextDocument | undefined {
		const fileName = uriToFsPath(uri);
		const version = Number(vueHost.getScriptVersion(fileName));
		if (!documents.has(uri) || documents.get(uri)!.version !== version) {
			const scriptSnapshot = vueHost.getScriptSnapshot(fileName);
			if (scriptSnapshot) {
				const scriptText = scriptSnapshot.getText(0, scriptSnapshot.getLength());
				const document = TextDocument.create(uri, uri.endsWith('.vue') ? 'vue' : 'typescript', version, scriptText);
				documents.set(uri, document);
			}
		}
		if (documents.has(uri)) {
			return documents.get(uri);
		}
		return templateTsLs.__internal__.getTextDocumentUncheck(uri);
	}
	function getSourceFile(uri: string) {
		return sourceFiles.get(uri);
	}
	function getAllSourceFiles() {
		return [...sourceFiles.values()];
	}
	function updateSourceFiles(uris: string[], shouldUpdateTemplateScript: boolean) {
		let vueScriptsUpdated = false;
		let vueTemplateScriptUpdated = false;

		if (shouldUpdateTemplateScript) {
			for (const cb of initProgressCallback) {
				cb(0);
			}
		}
		for (const uri of uris) {
			const sourceFile = sourceFiles.get(uri);
			const doc = getTextDocument(uri);
			if (!doc) continue;
			if (!sourceFile) {
				sourceFiles.set(uri, createSourceFile(
					doc,
					templateTsLs,
					scriptTsLs,
					context,
				));
				vueScriptsUpdated = true;
			}
			else {
				const updates = sourceFile.update(doc);
				if (updates.scriptUpdated) {
					vueScriptsUpdated = true;
				}
				if (updates.templateScriptUpdated) {
					vueTemplateScriptUpdated = true;
				}
			}
			templateScriptUpdateUris.add(uri);
		}
		if (vueScriptsUpdated) {
			updateTsProject(false);
		}
		if (shouldUpdateTemplateScript) {
			let currentNums = 0;
			for (const uri of templateScriptUpdateUris) {
				if (sourceFiles.get(uri)?.updateTemplateScript()) {
					vueTemplateScriptUpdated = true;
				}
				for (const cb of initProgressCallback) {
					cb(++currentNums / templateScriptUpdateUris.size);
				}
			}
			templateScriptUpdateUris.clear();
			for (const cb of initProgressCallback) {
				cb(1);
			}
			initProgressCallback.length = 0;
		}
		if (vueTemplateScriptUpdated) {
			updateTsProject(true);
		}
	}
	function unsetSourceFiles(uris: string[]) {
		let updated = false;
		for (const uri of uris) {
			if (sourceFiles.delete(uri)) {
				updated = true;
			}
		}
		if (updated) {
			updateTsProject(false);
		}
	}
	function updateTsProject(isTemplateUpdate: boolean) {
		tsProjectVersion++;
		if (!isTemplateUpdate) {
			tsProjectVersionWithoutTemplate++;
		}
	}
}
function createContext(
	ts: typeof import('typescript/lib/tsserverlibrary'),
	vueHost?: LanguageServiceHost,
) {
	const fileSystemProvider: html.FileSystemProvider = {
		stat: (uri) => {
			return new Promise<html.FileStat>((resolve, reject) => {
				fs.stat(uriToFsPath(uri), (err, stats) => {
					if (stats) {
						resolve({
							type: stats.isFile() ? html.FileType.File
								: stats.isDirectory() ? html.FileType.Directory
									: stats.isSymbolicLink() ? html.FileType.SymbolicLink
										: html.FileType.Unknown,
							ctime: stats.ctimeMs,
							mtime: stats.mtimeMs,
							size: stats.size,
						});
					}
					else {
						reject(err);
					}
				});
			});
		},
		readDirectory: (uri) => {
			return new Promise<[string, html.FileType][]>((resolve, reject) => {
				fs.readdir(uriToFsPath(uri), (err, files) => {
					if (files) {
						resolve(files.map(file => [file, html.FileType.File]));
					}
					else {
						reject(err);
					}
				});
			});
		},
	}
	const htmlLs = html.getLanguageService({ fileSystemProvider });
	const cssLs = css.getCSSLanguageService({ fileSystemProvider });
	const scssLs = css.getSCSSLanguageService({ fileSystemProvider });
	const lessLs = css.getLESSLanguageService({ fileSystemProvider });
	const pugLs = pug.getLanguageService(htmlLs);
	const jsonLs = json.getLanguageService({ schemaRequestService: vueHost?.schemaRequestService });
	const postcssLs: css.LanguageService = {
		...scssLs,
		doValidation: (document, stylesheet, documentSettings) => {
			let errors = scssLs.doValidation(document, stylesheet, documentSettings);
			errors = errors.filter(error => error.code !== 'css-semicolonexpected');
			errors = errors.filter(error => error.code !== 'css-ruleorselectorexpected');
			errors = errors.filter(error => error.code !== 'unknownAtRules');
			return errors;
		},
	};

	return {
		ts,
		htmlLs,
		pugLs,
		jsonLs,
		getCssLs,
		vueHost,
	};

	function getCssLs(lang: string) {
		switch (lang) {
			case 'css': return cssLs;
			case 'scss': return scssLs;
			case 'less': return lessLs;
			case 'postcss': return postcssLs;
		}
	}
}
