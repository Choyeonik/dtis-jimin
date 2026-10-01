# PC 자동 종료용 네이티브 메시징 호스트를 이 PC의 Chrome에 등록한다(관리자 권한 불필요).
# 이 폴더를 옮기면 경로가 바뀌므로 다시 실행해야 한다.

$hostName = "com.dtis.shutdown"
# manifest.json의 "key"로 고정된 확장프로그램 ID
$extensionId = "kofdjefoekolgliiinkakdjngbepkcjf"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $dir "$hostName.json"

$manifest = [ordered]@{
    name            = $hostName
    description     = "DTIS seat booking - shut down PC on success"
    path            = (Join-Path $dir "host.bat")
    type            = "stdio"
    allowed_origins = @("chrome-extension://$extensionId/")
}
# Chrome은 BOM이 붙은 JSON을 못 읽으므로 BOM 없는 UTF-8로 쓴다.
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

$regKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $regKey -Force | Out-Null
Set-ItemProperty -Path $regKey -Name "(default)" -Value $manifestPath

Write-Host "설치 완료: $manifestPath"
Write-Host "Chrome을 완전히 껐다 켠 뒤 확장프로그램을 새로고침하세요."
