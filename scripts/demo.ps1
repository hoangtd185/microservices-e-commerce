# End-to-end walkthrough against the gateway.
#   .\scripts\demo.ps1
$ErrorActionPreference = 'Stop'
$gw = 'http://localhost:3000'

function Post($path, $obj, $token, $extraHeaders) {
  $headers = @{}
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  if ($extraHeaders) { $extraHeaders.GetEnumerator() | ForEach-Object { $headers[$_.Key] = $_.Value } }
  Invoke-RestMethod -Uri "$gw$path" -Method Post -ContentType 'application/json' `
    -Headers $headers -Body ($obj | ConvertTo-Json -Compress)
}

function Get($path, $token) {
  $headers = @{}
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  Invoke-RestMethod -Uri "$gw$path" -Headers $headers
}

Write-Host "`n== health ==" -ForegroundColor Cyan
(Invoke-RestMethod "$gw/health").services | Format-Table service, status

Write-Host "== 1. register (public route) ==" -ForegroundColor Cyan
$suffix = Get-Random -Maximum 99999
$auth = Post '/api/auth/register' @{
  email    = "ada+$suffix@example.com"
  name     = 'Ada Lovelace'
  password = 'correct-horse-battery-staple'
}
$token = $auth.accessToken
$user  = $auth.user
"user  : $($user.id)  $($user.email)"
"token : $($token.Substring(0,32))..."

Write-Host "`n== 2. no token = no entry ==" -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$gw/api/orders" -Method Get | Out-Null
  Write-Host "  UNEXPECTED: the endpoint was open!" -ForegroundColor Red
} catch {
  Write-Host "  GET /api/orders without a token -> $($_.Exception.Response.StatusCode.value__) as expected" -ForegroundColor Green
}

Write-Host "`n== 3. catalog (public) ==" -ForegroundColor Cyan
$products = Invoke-RestMethod "$gw/api/products"
"$($products.Count) products seeded. The scarce ones:"
$products | Where-Object { $_.sku -like 'FLASH-*' -or $_.sku -like 'LIMITED-*' } |
  Format-Table sku, name, price, stock, reserved
$phone   = $products | Where-Object { $_.sku -eq 'PHONE-001' }
$limited = $products | Where-Object { $_.sku -eq 'LIMITED-01' }

Write-Host "== 4. happy path: 2 x PHONE-001 ==" -ForegroundColor Cyan
$ok = Post '/api/orders' @{ productId = $phone.id; quantity = 2 } $token
"order : $($ok.id)  status=$($ok.status)  total=$($ok.totalPrice)   <- returns immediately"
"        note: no userId in the body - it comes from the token"

Write-Host "`n== 5. failure path: 5 x LIMITED-01 (stock is 2) ==" -ForegroundColor Cyan
$bad = Post '/api/orders' @{ productId = $limited.id; quantity = 5 } $token
"order : $($bad.id)  status=$($bad.status)"

Write-Host "`n== 6. idempotency: the same request twice ==" -ForegroundColor Cyan
$key = [guid]::NewGuid().ToString()
$body = @{ productId = $phone.id; quantity = 1 }
$first  = Post '/api/orders' $body $token @{ 'Idempotency-Key' = $key }
$second = Post '/api/orders' $body $token @{ 'Idempotency-Key' = $key }
"1st call : $($first.id)"
"2nd call : $($second.id)"
if ($first.id -eq $second.id) {
  Write-Host "  same order id -> one purchase, not two" -ForegroundColor Green
} else {
  Write-Host "  DIFFERENT order ids -> idempotency is not working" -ForegroundColor Red
}

Write-Host "`n   waiting 3s for the outbox relay + Kafka to carry the events..." -ForegroundColor DarkGray
Start-Sleep -Seconds 3

Write-Host "== 7. orders after the saga finished ==" -ForegroundColor Cyan
Get "/api/orders" $token | Format-Table id, quantity, totalPrice, status, statusReason

Write-Host "== 8. why inventory decided that ==" -ForegroundColor Cyan
Get "/api/reservations/$($bad.id)" $token | Format-Table orderId, quantity, status, reason

Write-Host "== 9. user read model, rebuilt from order.confirmed ==" -ForegroundColor Cyan
Get "/api/users/$($user.id)" $token | Format-Table name, ordersCount, totalSpent

Write-Host "== 10. stock after reservation ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/products" |
  Where-Object { $_.id -in @($phone.id, $limited.id) } |
  Format-Table sku, stock, reserved

Write-Host "== 11. notifications produced by consuming events ==" -ForegroundColor Cyan
Get "/api/notifications?userId=$($user.id)" $token | Format-Table topic, channel, message -Wrap

Write-Host "Open http://localhost:8080 to see these messages sitting in Kafka.`n" -ForegroundColor Green
