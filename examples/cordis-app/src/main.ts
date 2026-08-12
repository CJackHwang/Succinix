import { runContract, type ContractResult } from './contract';

const output = document.getElementById('log') as HTMLPreElement;
let text = 'cordis-app contract running...\n';

function render(result?: ContractResult): void {
  if (result) {
    text = `[DONE] cordis-app: ${result.passed} passed, ${result.failed} failed\n\n`;
    for (const item of result.checks) {
      const marker = item.ok ? '[  OK  ]' : '[ FAIL ]';
      const cls = item.ok ? 'ok' : 'fail';
      text += `<span class="${cls}">${marker}</span> ${item.name}${item.detail ? ` (${item.detail})` : ''}\n`;
    }
    (window as unknown as Record<string, unknown>).__cordisResult = result;
  }
  output.innerHTML = text;
}

void runContract()
  .then((result) => {
    render(result);
  })
  .catch((error) => {
    text += `<span class="fail">[ FAIL ] contract runner crashed: ${String(error)}</span>\n`;
    render();
  });
