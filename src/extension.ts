import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';

let currentPanel: vscode.WebviewPanel | undefined = undefined;
let decorationType: vscode.TextEditorDecorationType;

export function activate(context: vscode.ExtensionContext) {
    
    // Create the "Highlighter" style (Yellow background)
    decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 255, 0, 0.3)',
        isWholeLine: true
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('viz.current', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("Open a file (Python, C, C++, Java) to visualize!");
                return;
            }

            const filePath = editor.document.fileName;
            const ext = path.extname(filePath).toLowerCase();

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Compiling & Tracing...",
                cancellable: false
            }, async () => {
                try {
                    let traceData: any[] = [];
                    
                    // --- SELECT ENGINE BASED ON LANGUAGE ---
                    if (ext === '.py') {
                        traceData = await runPythonTrace(filePath);
                    } else if (ext === '.c' || ext === '.cpp') {
                        // Pass 'true' if it is C++
                        traceData = await runGdbTrace(filePath, ext === '.cpp');
                    } else if (ext === '.java') {
                        traceData = await runJavaTrace(filePath);
                    } else {
                        throw new Error("Unsupported language: " + ext);
                    }

                    showVisualizerPanel(context.extensionUri, traceData, editor);
                } catch (err: any) {
                    vscode.window.showErrorMessage("Error: " + err.message);
                    console.error(err);
                }
            });
        })
    );
}

// =========================================================
// ENGINE 1: PYTHON TRACER (sys.settrace)
// =========================================================
function runPythonTrace(targetFile: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const tracerScript = `
import sys, json, os
target_file = r"${targetFile.replace(/\\/g, '\\\\')}"
execution_log = []

def trace_calls(frame, event, arg):
    if event != 'line': return trace_calls
    # Only trace the user's file
    if os.path.abspath(frame.f_code.co_filename) != os.path.abspath(target_file): return trace_calls
    
    local_vars = {}
    for k, v in frame.f_locals.items():
        if not k.startswith('__'):
            local_vars[k] = str(v)
    
    execution_log.append({ "line": frame.f_lineno, "vars": local_vars })
    return trace_calls

sys.settrace(trace_calls)
try:
    with open(target_file) as f:
        exec(compile(f.read(), target_file, 'exec'), {'__name__': '__main__'})
except Exception: pass
finally:
    sys.settrace(None)
    print("---JSON_START---")
    print(json.dumps(execution_log))
    print("---JSON_END---")
`;
        const tempPath = path.join(os.tmpdir(), 'rohit_py_trace.py');
        fs.writeFileSync(tempPath, tracerScript);
        
        cp.exec(`python "${tempPath}"`, (err, stdout, stderr) => {
            if (err && !stdout.includes("---JSON_START---")) {
                reject(stderr || err.message);
                return;
            }
            const parts = stdout.split("---JSON_START---");
            if (parts.length < 2) reject("No trace output found.");
            else resolve(JSON.parse(parts[1].split("---JSON_END---")[0]));
        });
    });
}

// =========================================================
// ENGINE 2: C/C++ TRACER (GDB Automation)
// =========================================================
async function runGdbTrace(targetFile: string, isCpp: boolean): Promise<any> {
    return new Promise((resolve, reject) => {
        const workDir = path.dirname(targetFile);
        const exeName = path.join(os.tmpdir(), 'rohit_viz_out.exe');
        
        // 1. Compile
        // Note: We use -g for debug symbols
        const compiler = isCpp ? 'g++' : 'gcc';
        const compileCmd = `${compiler} -g "${targetFile}" -o "${exeName}"`;
        
        cp.exec(compileCmd, { cwd: workDir }, (err, stdout, stderr) => {
            if (err) { reject("Compilation Failed: " + stderr); return; }

            // 2. Create GDB Script
            const gdbScriptPath = path.join(os.tmpdir(), 'trace_script.gdb');
            
            // CRITICAL FIX: "set print pretty off" ensures vectors print on one line
            const gdbCommands = `
file "${exeName.replace(/\\/g, '/')}"
set print pretty off
set print array off
set pagination off
break main
run
while 1
    info source
    info locals
    step
end
quit
`;
            fs.writeFileSync(gdbScriptPath, gdbCommands);

            // 3. Run GDB
            cp.exec(`gdb --batch -x "${gdbScriptPath}"`, (err, stdout) => {
                if (err) { reject("GDB Error: " + err.message); return; }
                const steps = parseGdbOutput(stdout);
                if (steps.length === 0) reject("GDB produced no trace steps.");
                resolve(steps);
            });
        });
    });
}

function parseGdbOutput(raw: string) {
    const lines = raw.split('\n');
    const steps: any[] = [];
    let currentLine = 0;
    let currentVars: any = {};

    for (const line of lines) {
        // Detect Line Number: "10\tfile.c" or "10\t in file.cpp"
        const lineMatch = line.match(/^(\d+)\s+/); 
        if (lineMatch) {
            // Save previous step
            if (currentLine > 0) {
                steps.push({ line: currentLine, vars: { ...currentVars } });
            }
            currentLine = parseInt(lineMatch[1]);
        }
        
        // Detect Variable: "name = value"
        // Regex handles "arr = {1, 2, 3}" correctly now
        const varMatch = line.match(/^([a-zA-Z0-9_]+) = (.+)$/);
        if (varMatch && currentLine > 0) {
            let val = varMatch[2].trim();
            // Clean up C++ vector syntax slightly if needed
            currentVars[varMatch[1]] = val;
        }
    }
    return steps;
}

// =========================================================
// ENGINE 3: JAVA TRACER (JDB Automation)
// =========================================================
async function runJavaTrace(targetFile: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const workDir = path.dirname(targetFile);
        const fileName = path.basename(targetFile); // MyClass.java
        const className = fileName.replace('.java', '');

        // 1. Compile
        cp.exec(`javac -g "${targetFile}"`, { cwd: workDir }, (err, stdout, stderr) => {
            if (err) { reject("Java Compile Failed: " + stderr); return; }

            // 2. Run JDB
            const jdb = cp.spawn('jdb', ['-classpath', '.', className], { cwd: workDir });
            
            let outputBuffer = '';
            const steps: any[] = [];

            // Script the JDB session
            jdb.stdin.write(`stop in ${className}.main\n`);
            jdb.stdin.write(`run\n`);
            
            // Step 50 times (safety limit)
            for(let i=0; i<50; i++) {
                jdb.stdin.write(`locals\n`);
                jdb.stdin.write(`step\n`);
            }
            jdb.stdin.write(`quit\n`);
            jdb.stdin.end();

            jdb.stdout.on('data', (data) => { outputBuffer += data.toString(); });
            
            jdb.on('close', () => {
                const lines = outputBuffer.split('\n');
                let currentLine = 0;
                let currentVars: any = {};

                lines.forEach(line => {
                    // JDB Line: "line=10"
                    if (line.includes(`line=`)) {
                        const match = line.match(/line=(\d+)/);
                        if (match) {
                            if (currentLine > 0) steps.push({ line: currentLine, vars: { ...currentVars } });
                            currentLine = parseInt(match[1]);
                        }
                    }
                    // JDB Var: "x = 5"
                    const varMatch = line.match(/^\s*([a-zA-Z0-9_]+) = (.+)$/);
                    if (varMatch && currentLine > 0 && !line.includes("method")) {
                        currentVars[varMatch[1]] = varMatch[2].trim();
                    }
                });
                resolve(steps);
            });
        });
    });
}

// =========================================================
// FRONTEND: WEBVIEW PANEL
// =========================================================
function showVisualizerPanel(extensionUri: vscode.Uri, traceData: any[], editor: vscode.TextEditor) {
    const column = vscode.ViewColumn.Beside;
    if (currentPanel) {
        currentPanel.reveal(column);
    } else {
        currentPanel = vscode.window.createWebviewPanel('vizPanel', 'Algo visualizer (Python)', column, { enableScripts: true });
        currentPanel.onDidDispose(() => { currentPanel = undefined; decorationType.dispose(); }, null, []);
    }

    currentPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <style>
        body { font-family: 'Segoe UI', sans-serif; padding: 10px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); user-select: none; }
        h3 { border-bottom: 1px solid #555; padding-bottom: 5px; }
        .var-box { background: rgba(255,255,255,0.05); border: 1px solid #444; padding: 6px; margin-bottom: 6px; font-family: monospace; border-radius: 4px; }
        .var-name { color: #569cd6; font-weight: bold; }
        .var-val { color: #ce9178; word-break: break-all; }
        
        .controls { display: flex; gap: 10px; margin-bottom: 15px; }
        button { 
            flex: 1; padding: 12px; cursor: pointer; 
            background: #007acc; color: white; border: none; 
            border-radius: 4px; font-weight: bold; font-size: 14px;
            transition: background 0.1s;
        }
        button:hover { background: #005f9e; }
        button:active { background: #004e80; }
        button:disabled { background: #444; cursor: not-allowed; color: #888; }
    </style>
</head>
<body>
    <h3>Algo visualizer (Python)</h3>
    <h4>Line: <span id="lineNum">Start</span></h4>
    
    <div class="controls">
        <button id="prevBtn">⬅ Prev</button>
        <button id="nextBtn">Next ➡</button>
    </div>

    <div id="variables"></div>

    <script>
        const vscode = acquireVsCodeApi();
        let trace = ${JSON.stringify(traceData)};
        let idx = -1;
        let autoStepInterval = null;

        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');

        // --- BUTTON EVENT LISTENERS (For Click & Long Press) ---
        setupButton(prevBtn, -1);
        setupButton(nextBtn, 1);

        function setupButton(btn, direction) {
            btn.addEventListener('mousedown', () => {
                step(direction); // Immediate step
                // Start auto-stepping after brief delay
                autoStepInterval = setInterval(() => step(direction), 100); 
            });
            btn.addEventListener('mouseup', stopAutoStep);
            btn.addEventListener('mouseleave', stopAutoStep);
        }

        function stopAutoStep() {
            if (autoStepInterval) {
                clearInterval(autoStepInterval);
                autoStepInterval = null;
            }
        }

        function step(dir) {
            const newIndex = idx + dir;
            
            // BOUNDARY CHECK
            if (newIndex >= 0 && newIndex < trace.length) {
                idx = newIndex;
                const frame = trace[idx];
                document.getElementById('lineNum').innerText = frame.line;
                
                let html = '';
                for (const [k, v] of Object.entries(frame.vars)) {
                    html += \`<div class="var-box"><span class="var-name">\${k}</span> = <span class="var-val">\${v}</span></div>\`;
                }
                document.getElementById('variables').innerHTML = html || '<em>No locals</em>';
                vscode.postMessage({ command: 'highlight', line: frame.line });
                
                updateButtons();
            } else {
                stopAutoStep(); // Stop auto-running if we hit the end
            }
        }
        
        function updateButtons() {
            prevBtn.disabled = (idx <= 0);
            nextBtn.disabled = (idx >= trace.length - 1);
        }

        // Initialize
        step(1); 
    </script>
</body>
</html>`;

    currentPanel.webview.onDidReceiveMessage(msg => {
        if (msg.command === 'highlight') {
            const range = new vscode.Range(msg.line - 1, 0, msg.line - 1, 1000);
            editor.setDecorations(decorationType, [range]);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
    });
}

export function deactivate() { if (currentPanel) currentPanel.dispose(); }