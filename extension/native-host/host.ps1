# Chrome 네이티브 메시징 호스트 — 확장프로그램이 보낸 "shutdown" 메시지를 받으면
# 윈도우 종료 명령을 실행한다. Chrome은 메시지를 "4바이트 길이(리틀엔디언) + UTF-8
# JSON" 형식으로 stdin에 보내고, 응답도 같은 형식으로 stdout에 받는다.

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Message {
    $lengthBytes = New-Object byte[] 4
    if ($stdin.Read($lengthBytes, 0, 4) -lt 4) { return $null }
    $length = [BitConverter]::ToInt32($lengthBytes, 0)
    if ($length -le 0) { return $null }
    $buffer = New-Object byte[] $length
    $offset = 0
    while ($offset -lt $length) {
        $n = $stdin.Read($buffer, $offset, $length - $offset)
        if ($n -le 0) { break }
        $offset += $n
    }
    return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $offset) | ConvertFrom-Json
}

function Write-Message($obj) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

$msg = Read-Message
if ($msg -and $msg.type -eq "shutdown") {
    $delay = 0
    if ($msg.delaySeconds) { $delay = [int]$msg.delaySeconds }
    Write-Message @{ ok = $true; delaySeconds = $delay }
    shutdown.exe /s /t $delay
} else {
    Write-Message @{ ok = $false; error = "unknown message" }
}
