# dsh-model-failover 自动同步监视器：改动 -> 自动 commit(post-commit 钩子自动 push)
$repo = "E:\DesRedTeam\test\dsh-model-failover"
$watch = @("index.js","client.js","package.json","cordis.patch.yml","README.md","LICENSE","icon.svg","locale","test")
$debounceSec = 8
function Get-TreeStamp {
    $files = foreach ($w in $watch) {
        $p = Join-Path $repo $w
        if (Test-Path $p -PathType Container) { Get-ChildItem $p -Recurse -File }
        elseif (Test-Path $p) { Get-Item $p }
    }
    ($files | ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }) -join "`n"
}
$last = Get-TreeStamp
$lastChange = Get-Date
$pending = $false
"watching $repo (debounce ${debounceSec}s)"
while ($true) {
    Start-Sleep -Seconds 3
    $now = Get-TreeStamp
    if ($now -ne $last) {
        $last = $now; $pending = $true; $lastChange = Get-Date
        continue
    }
    if ($pending -and ((Get-Date) - $lastChange).TotalSeconds -ge $debounceSec) {
        $pending = $false
        Push-Location $repo
        try {
            git add -A 2>$null
            $diff = git diff --cached --name-only
            if ($diff) {
                $msg = "auto-sync: update " + (($diff | Select-Object -First 3) -join ", ") + " (" + (Get-Date -Format "MM-dd HH:mm") + ")"
                git commit -m $msg 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { Write-Output ("[auto-sync] committed+pushed: " + $msg) }
            }
        } finally { Pop-Location }
    }
}
