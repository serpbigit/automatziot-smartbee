# Shows SmartBee support exactly where the API call stops: login works, document creation is refused.
# Prompts for the three API values, never prints them or the login token. Creates NOTHING:
# the request is a draft and is expected to be refused if the API role is missing.
# Usage:  powershell -ExecutionPolicy Bypass -File .\scripts\smartbee-role-check.ps1
param([string]$Base = 'https://smartbee.co.il/api/v1', [string]$Poll = '')

function Plain($s) { [Net.NetworkCredential]::new('', $s).Password }
function Call($method, $url, $headers, $body) {
  try {
    $r = Invoke-WebRequest -Method $method -Uri $url -Headers $headers -Body $body -ContentType 'application/json' -UseBasicParsing
    return @{ code = [int]$r.StatusCode; text = $r.Content }
  } catch {
    $code = 0; $text = $_.Exception.Message
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
    elseif ($_.Exception.Response -and $_.Exception.Response.GetResponseStream) {
      try { $text = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
    }
    return @{ code = $code; text = $text }
  }
}

$clientId = Read-Host 'API client id'
$password = Plain (Read-Host 'API password' -AsSecureString)
$provider = ''
if (-not $Poll) { $provider = Plain (Read-Host 'provider user token' -AsSecureString) }

Write-Host ''
Write-Host "Time (UTC): $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host "Server:     $Base"

Write-Host ''
Write-Host 'STEP 1: POST /login/authenticate'
$login = Call 'POST' "$Base/login/authenticate" @{} (@{ clientId = $clientId; password = $password } | ConvertTo-Json)
Write-Host "  HTTP $($login.code)"
$token = $null
try { $token = ($login.text | ConvertFrom-Json).token } catch {}
if ($token) { Write-Host '  Login OK (token received, not shown)' } else { Write-Host "  Login FAILED: $($login.text)"; return }

function Show-Status($id) {
  Write-Host ''
  Write-Host "STEP 3: GET /documents/$id (what SmartBee finally did with the request)"
  for ($i = 1; $i -le 4; $i++) {
    Start-Sleep -Seconds 3
    $st = Call 'GET' "$Base/documents/$id" @{ Authorization = "Bearer $token" } $null
    Write-Host "  try ${i}: HTTP $($st.code)  $($st.text)"
    if ($st.text -notmatch '"resultCodeId":10[23]') { break }
  }
}

if ($Poll) {
  Show-Status $Poll
  Write-Host ''
  Write-Host 'Send this output to SmartBee support. Nothing in it is secret.'
  return
}

Write-Host ''
Write-Host 'STEP 2: POST /documents/create (draft receipt, 1 ILS, test customer)'
$msgId = [guid]::NewGuid().ToString()
$doc = @{
  providerUserToken = $provider; providerMsgId = $msgId; providerMsgReferenceId = "role-check-$msgId".Substring(0, 40)
  docType = 'Receipt'; isDraft = $true
  customer = @{ name = 'Role Check Test'; providerCustomerId = 'role-check@example.com'; email = 'role-check@example.com' }
  receiptDetails = @{ cashItems = @(@{ date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); sum = 1 }) }
  creationMetadata = @{ language = 'HEB'; sendOriginalToCustomer = $false }
} | ConvertTo-Json -Depth 6
$create = Call 'POST' "$Base/documents/create" @{ Authorization = "Bearer $token" } $doc
Write-Host "  providerMsgId: $msgId"
Write-Host "  HTTP $($create.code)"
Write-Host "  Reply: $($create.text)"
$newId = $null
try { $newId = ($create.text | ConvertFrom-Json).result } catch {}
if ($newId -and $create.text -match '"resultCodeId":101') { Show-Status $newId }
Write-Host ''
Write-Host 'Send this output to SmartBee support. Nothing in it is secret.'
