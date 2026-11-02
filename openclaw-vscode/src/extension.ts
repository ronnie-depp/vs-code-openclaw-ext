import * as vscode from "vscode";

const TOKEN_KEY = "openclaw.gatewayToken";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("openclaw.setToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "OpenClaw Gateway Token",
        prompt: "Enter the token for your local OpenClaw Gateway",
        password: true,
        ignoreFocusOut: true
      });

      if (token) {
        await context.secrets.store(TOKEN_KEY, token);
        vscode.window.showInformationMessage("OpenClaw token saved securely.");
      }
    }),

    vscode.window.registerWebviewViewProvider(
      "openclaw.chat",
      new ChatViewProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "send") {
        await this.sendPrompt(view, String(message.text ?? ""));
      } else if (message.type === "insert") {
        await this.insertReply(String(message.text ?? ""));
      } else if (message.type === "setToken") {
        await vscode.commands.executeCommand("openclaw.setToken");
      }
    });
  }

  private async sendPrompt(view: vscode.WebviewView, prompt: string) {
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token) {
      view.webview.postMessage({
        type: "error",
        text: "Set your Gateway token first: run “OpenClaw: Set Gateway Token” from the Command Palette."
      });
      return;
    }

    const config = vscode.workspace.getConfiguration("openclaw");
    const endpoint = config.get<string>("endpoint", "http://127.0.0.1:18789")
      .replace(/\/+$/, "");
    const agent = config.get<string>("agent", "openclaw/default");

    const editor = vscode.window.activeTextEditor;
    const selectedText = editor
      ? editor.document.getText(editor.selection)
      : "";

    const contextText = selectedText
      ? `\n\nSelected code (language: ${editor?.document.languageId}):\n\`\`\`\n${selectedText}\n\`\`\``
      : "";

    const userMessage = `${prompt}${contextText}`;

    view.webview.postMessage({ type: "status", text: "Thinking…" });

    try {
      const response = await fetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: agent,
          user: "vscode-openclaw",
          messages: [
            {
              role: "system",
              content:
                "You are a coding assistant. Explain proposed changes clearly. " +
                "Do not claim to have edited files or run commands."
            },
            { role: "user", content: userMessage }
          ],
          stream: false
        })
      });

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };

      if (!response.ok) {
        throw new Error(data.error?.message ?? `HTTP ${response.status}`);
      }

      const answer = data.choices?.[0]?.message?.content;
      if (!answer) throw new Error("OpenClaw returned an empty response.");

      view.webview.postMessage({ type: "reply", text: answer });
    } catch (error) {
      view.webview.postMessage({
        type: "error",
        text: `Request failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private async insertReply(text: string) {
    const config = vscode.workspace.getConfiguration("openclaw");
    if (config.get<boolean>("confirmBeforeInsert", true)) {
      const choice = await vscode.window.showWarningMessage(
        "Insert the assistant’s entire reply at the current cursor?",
        { modal: true },
        "Insert"
      );
      if (choice !== "Insert") return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("Open a file and place the cursor first.");
      return;
    }

    await editor.edit((edit) => edit.replace(editor.selection, text));
  }

  private html() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); padding: 8px; }
  textarea { box-sizing: border-box; width: 100%; min-height: 90px; }
  button { margin: 6px 4px 6px 0; }
  #reply { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 12px; }
  #status { opacity: .8; }
</style>
</head>
<body>
  <textarea id="prompt" placeholder="Ask about your code…"></textarea>
  <div>
    <button id="send">Ask OpenClaw</button>
    <button id="token">Set token</button>
    <button id="insert" hidden>Insert reply…</button>
  </div>
  <div id="status"></div>
  <pre id="reply"></pre>
<script>
  const vscode = acquireVsCodeApi();
  const prompt = document.getElementById("prompt");
  const reply = document.getElementById("reply");
  const status = document.getElementById("status");
  const insert = document.getElementById("insert");
  let latestReply = "";

  document.getElementById("send").onclick = () => {
    const text = prompt.value.trim();
    if (text) vscode.postMessage({ type: "send", text });
  };
  document.getElementById("token").onclick = () =>
    vscode.postMessage({ type: "setToken" });
  insert.onclick = () =>
    vscode.postMessage({ type: "insert", text: latestReply });

  window.addEventListener("message", event => {
    const message = event.data;
    if (message.type === "status") status.textContent = message.text;
    if (message.type === "reply") {
      latestReply = message.text;
      reply.textContent = message.text;
      status.textContent = "";
      insert.hidden = false;
    }
    if (message.type === "error") {
      status.textContent = message.text;
      insert.hidden = true;
    }
  });
</script>
</body>
</html>`;
  }
}

export function deactivate() {}
