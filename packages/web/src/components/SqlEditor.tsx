import { lazy, Suspense, useEffect, useRef } from "react";
import type { OnChange, OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor, IDisposable, Position } from "monaco-editor";

import type { BrowserTableInfo } from "@filesql/core";

const MonacoEditorView = lazy(async () => {
  const module = await import("@monaco-editor/react");
  return { default: module.default };
});

type SqlEditorProps = {
  onRun: () => void;
  onValueChange: (value: string) => void;
  tables: BrowserTableInfo[];
  value: string;
};

export function SqlEditor({ onRun, onValueChange, tables, value }: SqlEditorProps) {
  const tablesRef = useRef(tables);
  const providerRef = useRef<IDisposable | null>(null);

  useEffect(() => {
    tablesRef.current = tables;
  }, [tables]);

  const handleMount: OnMount = (editor, monaco) => {
    if (!providerRef.current) {
      providerRef.current = monaco.languages.registerCompletionItemProvider("sql", {
        provideCompletionItems(model: MonacoEditor.ITextModel, position: Position) {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions = tablesRef.current.flatMap((table) => {
            const tableSuggestion = {
              detail: `${table.kind.toUpperCase()} table`,
              insertText: table.name,
              kind: monaco.languages.CompletionItemKind.Struct,
              label: table.name,
              range,
            };

            const columnSuggestions = table.columns.flatMap((column) => [
              {
                detail: `${column.type} from ${table.name}`,
                insertText: column.name,
                kind: monaco.languages.CompletionItemKind.Field,
                label: column.name,
                range,
              },
              {
                detail: `${column.type} from ${table.name}`,
                insertText: `${table.name}.${column.name}`,
                kind: monaco.languages.CompletionItemKind.Field,
                label: `${table.name}.${column.name}`,
                range,
              },
            ]);

            return [tableSuggestion, ...columnSuggestions];
          });

          return { suggestions };
        },
      });
    }

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      onRun();
    });
  };

  const handleChange: OnChange = (nextValue) => {
    onValueChange(nextValue ?? "");
  };

  return (
    <div className="editor-surface">
      <Suspense fallback={<div className="editor-loading">Loading Monaco editor...</div>}>
        <MonacoEditorView
          defaultLanguage="sql"
          height="420px"
          onChange={handleChange}
          onMount={handleMount}
          options={{
            automaticLayout: true,
            fontSize: 14,
            minimap: { enabled: false },
            padding: { top: 16, bottom: 16 },
            quickSuggestions: true,
            scrollBeyondLastLine: false,
            wordWrap: "on",
          }}
          theme="vs-dark"
          value={value}
        />
      </Suspense>
    </div>
  );
}
