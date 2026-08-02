# End-to-end walkthrough against the gateway.
#   .\scripts\demo.ps1
$ErrorActionPreference = 'Stop'
$gw = 'http://localhost:3000'

function Post($path, $obj) {
  Invoke-RestMethod -Uri "$gw$path" -Method Post -ContentType 'application/json' `
    -Body ($obj | ConvertTo-Json -Compress)
}

function PostWithKey($path, $obj, $key) {
  $r = Invoke-WebRequest -Uri "$gw$path" -Method Post -ContentType 'application/json' `
    -Headers @{ 'Idempotency-Key' = $key } -Body ($obj | ConvertTo-Json -Compress)
  [pscustomobject]@{
    Body   = $r.Content | ConvertFrom-Json
    Replay = [bool]$r.Headers['Idempotent-Replay']
  }
}

Write-Host "`n== health ==" -ForegroundColor Cyan
(Invoke-RestMethod "$gw/health").services | Format-Table service, status

Write-Host "== 1. create a user ==" -ForegroundColor Cyan
$suffix = Get-Random -Maximum 99999
$user = Post '/api/users' @{ email = "ada+$suffix@example.com"; name = 'Ada Lovelace' }
"user  : $($user.id)  $($user.email)"

Write-Host "`n== 2. catalog ==" -ForegroundColor Cyan
$products = Invoke-RestMethod "$gw/api/products"
"$($products.Count) products seeded. The scarce ones:"
$products | Where-Object { $_.sku -like 'FLASH-*' -or $_.sku -like 'LIMITED-*' } |
  Format-Table sku, name, price, stock, reserved
$phone   = $products | Where-Object { $_.sku -eq 'PHONE-001' }
$limited = $products | Where-Object { $_.sku -eq 'LIMITED-01' }

Write-Host "== 3. happy path: 2 x PHONE-001 ==" -ForegroundColor Cyan
$ok = Post '/api/orders' @{ userId = $user.id; productId = $phone.id; quantity = 2 }
"order : $($ok.id)  status=$($ok.status)  total=$($ok.totalPrice)   <- returns immediately"

Write-Host "`n== 4. failure path: 5 x LIMITED-01 (stock is 2) ==" -ForegroundColor Cyan
$bad = Post '/api/orders' @{ userId = $user.id; productId = $limited.id; quantity = 5 }
"order : $($bad.id)  status=$($bad.status)"

Write-Host "`n== 5. idempotency: the same request sent twice ==" -ForegroundColor Cyan
$key = [guid]::NewGuid().ToString()
$body = @{ userId = $user.id; productId = $phone.id; quantity = 1 }
$first  = PostWithKey '/api/orders' $body $key
$second = PostWithKey '/api/orders' $body $key
"1st call : order $($first.Body.id)  replay=$($first.Replay)"
"2nd call : order $($second.Body.id)  replay=$($second.Replay)"
if ($first.Body.id -eq $second.Body.id) {
  Write-Host "  same order id -> one purchase, not two" -ForegroundColor Green
} else {
  Write-Host "  DIFFERENT order ids -> idempotency is not working" -ForegroundColor Red
}

Write-Host "`n   waiting 3s for Kafka to carry the events around..." -ForegroundColor DarkGray
Start-Sleep -Seconds 3

Write-Host "== 6. orders after the saga finished ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/orders?userId=$($user.id)" |
  Format-Table id, quantity, totalPrice, status, statusReason

Write-Host "== 7. why inventory decided that ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/reservations/$($bad.id)" |
  Format-Table orderId, quantity, status, reason

Write-Host "== 8. user read model, rebuilt from order.confirmed ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/users/$($user.id)" | Format-Table name, ordersCount, totalSpent

Write-Host "== 9. stock after reservation ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/products" |
  Where-Object { $_.id -in @($phone.id, $limited.id) } |
  Format-Table sku, stock, reserved

Write-Host "== 10. notifications produced by consuming events ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/notifications?userId=$($user.id)" |
  Format-Table topic, channel, message -Wrap

Write-Host "Open http://localhost:8080 to see these messages sitting in Kafka.`n" -ForegroundColor Green
