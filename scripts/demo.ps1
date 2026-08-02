# End-to-end walkthrough against the gateway.
#   .\scripts\demo.ps1
$ErrorActionPreference = 'Stop'
$gw = 'http://localhost:3000'

function Post($path, $obj) {
  Invoke-RestMethod -Uri "$gw$path" -Method Post -ContentType 'application/json' `
    -Body ($obj | ConvertTo-Json -Compress)
}

Write-Host "`n== health ==" -ForegroundColor Cyan
(Invoke-RestMethod "$gw/health").services | Format-Table service, status

Write-Host "== 1. create a user ==" -ForegroundColor Cyan
$suffix = Get-Random -Maximum 99999
$user = Post '/api/users' @{ email = "ada+$suffix@example.com"; name = 'Ada Lovelace' }
"user  : $($user.id)  $($user.email)"

Write-Host "`n== 2. products in stock ==" -ForegroundColor Cyan
$products = Invoke-RestMethod "$gw/api/products"
$products | Format-Table sku, name, price, stock
$phone   = $products | Where-Object { $_.sku -eq 'PHONE-01' }
$limited = $products | Where-Object { $_.sku -eq 'LIMITED-01' }

Write-Host "== 3. happy path: order 2 x PHONE-01 ==" -ForegroundColor Cyan
$ok = Post '/api/orders' @{ userId = $user.id; productId = $phone.id; quantity = 2 }
"order : $($ok.id)  status=$($ok.status)  total=$($ok.totalPrice)   <- returns immediately"

Write-Host "`n== 4. failure path: order 5 x LIMITED-01 (stock is 2) ==" -ForegroundColor Cyan
$bad = Post '/api/orders' @{ userId = $user.id; productId = $limited.id; quantity = 5 }
"order : $($bad.id)  status=$($bad.status)"

Write-Host "`n   waiting 3s for Kafka to carry the events around..." -ForegroundColor DarkGray
Start-Sleep -Seconds 3

Write-Host "== 5. same two orders, after the saga finished ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/orders?userId=$($user.id)" |
  Format-Table id, quantity, totalPrice, status, statusReason

Write-Host "== 6. user read model, rebuilt from order.confirmed ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/users/$($user.id)" | Format-Table name, ordersCount, totalSpent

Write-Host "== 7. stock after reservation ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/products" | Format-Table sku, stock, reserved

Write-Host "== 8. notifications produced by consuming events ==" -ForegroundColor Cyan
Invoke-RestMethod "$gw/api/notifications?userId=$($user.id)" |
  Format-Table topic, channel, message -Wrap

Write-Host "Open http://localhost:8080 to see these messages sitting in Kafka.`n" -ForegroundColor Green
