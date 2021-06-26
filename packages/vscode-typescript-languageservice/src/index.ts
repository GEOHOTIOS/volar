import * as ShPlugin from 'typescript-vscode-sh-plugin';
import * as completions from './services/completion';
import * as completionResolve from './services/completionResolve';
import * as definitions from './services/definition';
import * as typeDefinitions from './services/typeDefinition';
import * as references from './services/references';
import * as prepareRename from './services/prepareRename';
import * as rename from './services/rename';
import * as fileRename from './services/fileRename';
import * as codeActions from './services/codeAction';
import * as codeActionResolve from './services/codeActionResolve';
import * as hover from './services/hover';
import * as signatureHelp from './services/signatureHelp';
import * as selectionRanges from './services/selectionRanges';
import * as diagnostics from './services/diagnostics';
import * as documentHighlight from './services/documentHighlight';
import * as documentSymbol from './services/documentSymbol';
import * as workspaceSymbols from './services/workspaceSymbol';
import * as formatting from './services/formatting';
import * as semanticTokens from './services/semanticTokens';
import * as foldingRanges from './services/foldingRanges';
import * as callHierarchy from './services/callHierarchy';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { uriToFsPath } from '@volar/shared';
export type { LanguageServiceHost } from 'typescript';
import type { LanguageServiceHost } from 'typescript';
export type LanguageService = ReturnType<typeof createLanguageService>;
export { getSemanticTokenLegend } from './services/semanticTokens';

export function createLanguageService(_host: LanguageServiceHost, ts: typeof import('typescript/lib/tsserverlibrary')) {

	// @ts-ignore
	const importSuggestionsCache = ts.Completions?.createImportSuggestionsForFileCache?.();
	const host = {
		..._host,
		// @ts-ignore
		// TODO: crash on 'addListener' from 'node:process', reuse because TS has same problem
		getImportSuggestionsCache: () => importSuggestionsCache,
	};
	const documents = new Map<string, [string, TextDocument]>();
	const shPlugin = ShPlugin({ typescript: ts });
	let languageService = ts.createLanguageService(host);
	languageService = shPlugin.decorate(languageService);

	return {
		findDefinition: definitions.register(languageService, getTextDocumentCheck),
		findTypeDefinition: typeDefinitions.register(languageService, getTextDocumentCheck),
		findReferences: references.register(languageService, getTextDocumentCheck),
		prepareRename: prepareRename.register(languageService, getTextDocumentCheck),
		doRename: rename.register(languageService, getTextDocumentCheck),
		getEditsForFileRename: fileRename.register(languageService, getTextDocumentCheck),
		getCodeActions: codeActions.register(languageService, getTextDocumentCheck),
		doCodeActionResolve: codeActionResolve.register(languageService, getTextDocumentCheck),

		findDocumentHighlights: documentHighlight.register(languageService, getTextDocumentCheck, ts),
		findDocumentSymbols: documentSymbol.register(languageService, getTextDocumentCheck),
		findWorkspaceSymbols: workspaceSymbols.register(languageService, getTextDocumentCheck),
		doComplete: completions.register(languageService, getTextDocumentCheck, host.getCurrentDirectory()),
		doCompletionResolve: completionResolve.register(languageService, getTextDocumentCheck, ts),
		doHover: hover.register(languageService, getTextDocumentCheck, ts),
		doFormatting: formatting.register(languageService, getTextDocumentCheck),
		getSignatureHelp: signatureHelp.register(languageService, getTextDocumentCheck, ts),
		getSelectionRange: selectionRanges.register(languageService, getTextDocumentCheck),
		doValidation: diagnostics.register(languageService, getTextDocumentCheck, ts),
		getFoldingRanges: foldingRanges.register(languageService, getTextDocumentCheck, ts),
		getDocumentSemanticTokens: semanticTokens.register(languageService, getTextDocumentCheck),
		callHierarchy: callHierarchy.register(languageService, getTextDocumentCheck),

		dispose,

		__internal__: {
			raw: languageService,
			host,
			getTextDocumentUncheck,
			getTextDocumentCheck,
		},
	};

	function getTextDocumentCheck(uri: string) {
		const fileName = uriToFsPath(uri);
		if (!languageService.getProgram()?.getSourceFile(fileName)) {
			return;
		}
		return getTextDocumentUncheck(uri);
	}
	function getTextDocumentUncheck(uri: string) {
		const fileName = uriToFsPath(uri);
		const version = host.getScriptVersion(fileName);
		const oldDoc = documents.get(uri);
		if (!oldDoc || oldDoc[0] !== version) {
			const scriptSnapshot = host.getScriptSnapshot(fileName);
			if (scriptSnapshot) {
				const scriptText = scriptSnapshot.getText(0, scriptSnapshot.getLength());
				const document = TextDocument.create(uri, uri.endsWith('.vue') ? 'vue' : 'typescript', oldDoc ? oldDoc[1].version + 1 : 0, scriptText);
				documents.set(uri, [version, document]);
			}
		}
		return documents.get(uri)?.[1];
	}
	function dispose() {
		languageService.dispose();
	}
}
