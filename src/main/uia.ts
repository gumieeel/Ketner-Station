import { psQuote, runPowerShell } from './powershell';

/**
 * Доступ к интерфейсу активного окна через Windows UI Automation: видеть кнопки и ссылки
 * (в том числе на веб-страницах в браузере) и нажимать их по названию.
 * Модель не видит экран, и именно это даёт ей «глаза» без скриншотов.
 */

const HEAD = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace Ketner -Name Ui -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);'
[void][Ketner.Ui]::SetProcessDPIAware()
$interactive = @('Button','Hyperlink','MenuItem','TabItem','ListItem','CheckBox','RadioButton','SplitButton','ComboBox','Edit','TreeItem','DataItem')
function Get-UiItems {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([Ketner.Ui]::GetForegroundWindow())
  $cr = New-Object System.Windows.Automation.CacheRequest
  $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  $cr.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
  $cr.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
  $cr.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
  $scope = $cr.Activate()
  try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) } finally { $scope.Dispose() }
  $items = New-Object System.Collections.ArrayList
  foreach ($e in $all) {
    $n = $e.Cached.Name
    if ([string]::IsNullOrWhiteSpace($n) -or $e.Cached.IsOffscreen) { continue }
    $t = $e.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    [void]$items.Add([pscustomobject]@{ El = $e; Name = $n.Trim(); Type = $t })
  }
  return $items
}
`;

export function buildListScript(): string {
  return `${HEAD}
$items = $null
for ($try = 0; $try -lt 3; $try++) {
  $items = @(Get-UiItems)
  if ($items.Count -gt 3) { break }
  Start-Sleep -Milliseconds 1500
}
$seen = @{}
$lines = New-Object System.Collections.ArrayList
foreach ($i in $items) {
  if ($interactive -notcontains $i.Type) { continue }
  $name = if ($i.Name.Length -gt 80) { $i.Name.Substring(0, 80) } else { $i.Name }
  $key = "$($i.Type): $name"
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  [void]$lines.Add($key)
  if ($lines.Count -ge 80) { break }
}
if ($lines.Count -eq 0) { 'EMPTY' } else { $lines -join "\`n" }`;
}

export function buildClickScript(texts: string[], timeoutSec = 15): string {
  const list = texts.map((t) => psQuote(t.toLowerCase())).join(', ');
  const seconds = Math.max(1, Math.min(30, Math.round(timeoutSec)));
  return `${HEAD}
$queries = @(${list})
$deadline = (Get-Date).AddSeconds(${seconds})
$pick = $null
do {
  $items = @(Get-UiItems)
  foreach ($q in $queries) {
    $m = @($items | Where-Object { $_.Name.ToLowerInvariant().Contains($q) })
    if ($m.Count -gt 0) {
      $pick = $m | Sort-Object @{ Expression = { if ($_.Name.ToLowerInvariant() -eq $q) { 0 } elseif ($_.Name.ToLowerInvariant().StartsWith($q)) { 1 } else { 2 } } }, @{ Expression = { if ($interactive -contains $_.Type) { 0 } else { 1 } } } | Select-Object -First 1
      break
    }
  }
  if ($pick) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if (-not $pick) { 'NOTFOUND'; return }
try {
  $p = $pick.El.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $p.Invoke()
  "CLICKED:$($pick.Type):$($pick.Name)"
  return
} catch {}
$r = $pick.El.Cached.BoundingRectangle
$x = [int]($r.Left + $r.Width / 2)
$y = [int]($r.Top + $r.Height / 2)
[void][Ketner.Ui]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 80
[Ketner.Ui]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[Ketner.Ui]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
"CLICKED:$($pick.Type):$($pick.Name)"`;
}

export async function uiList(): Promise<string> {
  const r = await runPowerShell(buildListScript(), 40_000);
  if (r.code !== 0) throw new Error(r.stderr || 'Не удалось прочитать интерфейс окна.');
  if (r.stdout === 'EMPTY') return 'В активном окне не видно кнопок и ссылок (страница ещё грузится или окно не поддерживает доступ к элементам).';
  return `Элементы активного окна:\n${r.stdout}`;
}

/** Нажимает первый подходящий элемент; ждёт его появления до `timeoutSec` секунд (страница может ещё грузиться). */
export async function uiClick(text: string, alternatives: string[] = [], timeoutSec = 15): Promise<string> {
  const r = await runPowerShell(buildClickScript([text, ...alternatives], timeoutSec), (Math.min(30, timeoutSec) + 15) * 1000);
  if (r.code !== 0) throw new Error(r.stderr || 'Не удалось нажать элемент.');
  if (r.stdout === 'NOTFOUND') return `Элемент «${text}» не найден в активном окне. Вызовите ui_list, чтобы увидеть доступные кнопки и ссылки.`;
  const m = /^CLICKED:([^:]*):(.*)$/s.exec(r.stdout);
  return m ? `Нажато: ${m[2]} (${m[1]}).` : r.stdout;
}
