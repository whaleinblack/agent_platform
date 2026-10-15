$ErrorActionPreference = 'Stop'
$data = Join-Path $PSScriptRoot '.data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$resultFile = Join-Path $data 'hosts-setup-result.json'
try {
    $hostsFile = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'
    $bytes = [IO.File]::ReadAllBytes($hostsFile)
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    $offset = 0
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
        $encoding = New-Object Text.UTF8Encoding($true); $offset = 3
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
        $encoding = [Text.Encoding]::Unicode; $offset = 2
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 254 -and $bytes[1] -eq 255) {
        $encoding = [Text.Encoding]::BigEndianUnicode; $offset = 2
    }
    try { $content = $encoding.GetString($bytes, $offset, $bytes.Length - $offset) }
    catch { $encoding = [Text.Encoding]::Default; $content = $encoding.GetString($bytes) }
    $newline = "`n"
    if ($content.Contains("`r`n")) { $newline = "`r`n" }
    $lines = New-Object 'Collections.Generic.List[string]'
    foreach ($line in [regex]::Split($content, '\r\n|\n|\r')) {
        $parts = $line -split '#', 2
        $tokens = @($parts[0].Trim() -split '\s+' | Where-Object { $_ })
        if ($tokens.Count -gt 1 -and @($tokens | Select-Object -Skip 1 | Where-Object { $_ -ieq 'agents' }).Count -gt 0) {
            $remaining = @($tokens | Select-Object -Skip 1 | Where-Object { $_ -ine 'agents' })
            if ($remaining.Count -gt 0) {
                $replacement = $tokens[0] + "`t" + ($remaining -join ' ')
                if ($parts.Count -gt 1) { $replacement += ' #' + $parts[1] }
                $lines.Add($replacement)
            } elseif ($parts.Count -gt 1 -and $parts[1].Trim() -ne 'Agent Coordinator') {
                $lines.Add('#' + $parts[1])
            }
        } else { $lines.Add($line) }
    }
    $updated = $lines -join $newline
    if ($updated.Length -gt 0 -and !$updated.EndsWith($newline)) { $updated += $newline }
    $updated += '127.0.0.1 agents # Agent Coordinator' + $newline
    $modified = $updated -cne $content
    if ($modified) {
        $backup = Join-Path $data ('hosts-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bin')
        [IO.File]::WriteAllBytes($backup, $bytes)
        [IO.File]::WriteAllText($hostsFile, $updated, $encoding)
    }
    Clear-DnsClientCache -ErrorAction SilentlyContinue
    $result = @{ ok = $true; host = 'agents'; address = '127.0.0.1'; modified = $modified; at = (Get-Date).ToString('o') }
    $result | ConvertTo-Json | Set-Content -LiteralPath $resultFile -Encoding UTF8
} catch {
    @{ ok = $false; error = $_.Exception.Message; at = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $resultFile -Encoding UTF8
    exit 1
}
