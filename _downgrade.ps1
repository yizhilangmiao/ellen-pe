$ErrorActionPreference = 'Continue'
$eb  = "E:\ailian\工具\esbuild\esbuild.exe"
$web = "E:\ailian\_临时\legacy\web"
$out = "E:\ailian\_临时\legacy\web_out"

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

$files = Get-ChildItem -Path $web -Recurse -File -Include *.js,*.mjs
Write-Output "js files: $($files.Count)"

$okCount = 0; $failCount = 0
foreach ($f in $files) {
    $rel = $f.FullName.Substring($web.Length).TrimStart('\')
    $dstPath = Join-Path $out $rel
    $dstDir = Split-Path $dstPath -Parent
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }

    if ($f.Length -eq 0) {
        Copy-Item $f.FullName $dstPath -Force
        Write-Output ("[SKIP-EMPTY] {0}" -f $rel)
        continue
    }

    $fmt = if ($rel -like "*.mjs") { "esm" } else { "esm" }
    & $eb $f.FullName --target=chrome64 --format=$fmt --outfile=$dstPath --log-level=error 2>&1 | ForEach-Object { Write-Output ("  [eb] {0}" -f $_) }
    if ((Test-Path $dstPath) -and ((Get-Item $dstPath).Length -gt 0)) {
        $inLen = $f.Length; $outLen = (Get-Item $dstPath).Length
        Write-Output ("[OK] {0}  {1} -> {2}" -f $rel, $inLen, $outLen)
        $okCount++
    } else {
        Write-Output ("[FAIL] {0}" -f $rel)
        $failCount++
    }
}

Write-Output "---- summary: ok=$okCount fail=$failCount ----"

# 校验降级效果：统计新语法残留
Write-Output "---- syntax residue check (in web_out) ----"
$pat = @{
    'nullish_assign' = '\?\?='
    'or_assign'      = '\|\|='
    'and_assign'     = '&&='
    'optional_chain' = '\?\.'
    'nullish_coal'   = '\?\?[^=]'
}
foreach ($f in (Get-ChildItem -Path $out -Recurse -File -Include *.js,*.mjs)) {
    $txt = [System.IO.File]::ReadAllText($f.FullName)
    $hits = @()
    foreach ($k in $pat.Keys) {
        $c = ([regex]::Matches($txt, $pat[$k])).Count
        if ($c -gt 0) { $hits += "$k=$c" }
    }
    if ($hits.Count -gt 0) {
        Write-Output ("  {0}: {1}" -f $f.Name, ($hits -join ' '))
    }
}
Write-Output "---- residue check done ----"
