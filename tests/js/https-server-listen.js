// Verifies https.createServer + listen reaches its "listening" callback.
// Does NOT test request/response roundtrip — that requires sock_connect
// (currently `no-outbound` debt) OR the browser-side service-worker
// bridge with HTTPS framing (also not implemented).
const https = require('https');

const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC1HYUaGmniu6TF
DycScwEUvppMokOj7QWu+KhmRfj/a2NNoJJd3CTH6TaVEOUANRMhOdqOopsYunWr
ZNWniA7T0v3xyf33pMLgX4GDZygXkGY4NWGeE5ya4tyo5nVtZhp44DRGm5VQRsm7
sbVGgPyVR3S9g8uK5u2KShOQFxf8Jt5N88vy3H4yLhfWOFSVzmfpO7HR7NR7xmSj
LLocChM3aJliSaazlfHGQdb4PGorlaCfed2PEPJMexAmwVxpDS7q7loaouZreYpW
U40VC5WmStTt9B5i+4w1+2n5mEz6DQZ0SzoyVSCTbECqb5Xj7mFKwmBmzQJZ67gt
atwgkxQJAgMBAAECggEABdIcTj21k/ggYEXvpUfla7+BcX+QiXLraRdsQBc1HK5c
m2jS82nJE9SysKFBnttV0U5M8CMZNXb+o6LCvBbjFRs1lqD9hMk6ix/+p1S4JOO6
6UkL6VrrgE3Utifr87dhl+tquq8y4gjYYGwibZDlLT4F6jZTYxQvY6+kR8/6MRwX
pKYtedIuWoG6JZ8UMl8mRLXkb70sv40Jl9gOIxlNL/YOwWOhuIMXhDNylqVqVlWn
rWrvZuvuIz4RRnAZC/rS+wXhhPPNAU0BoJWu/EgCasSFUaI/pkJ4mjdrpsEaitYG
1O3FEHlqypkq7NIGIeZphR+8soQcx4wEXbKvtgt4oQKBgQD+5+mETfTxOc2wML8y
NyMnN1J18PCpwQYg0J5wxqLVsMjAIF7XR93SgaZAxmoDYv5fTAWuKsKOuvUxheb8
S5z+bk9fv4w3qn/EJavb3/aWWazwLd5IPlRZ4lqkKsqSd9MvLGkqoTXXfEo16hUd
bBBwoF5DUVvGEU/xjmkjqQsG8QKBgQC15IcHUVMYU60MqNGMbA6wMoOyfSd/oVgd
jQPhsw9E6HeXcsqOvg6YtvQoCOwUWNU9nC8Exyvk1r9EJYCWX+CPjVHSyI9Zgmj2
4yn6UduinpMgYPg8mlpWXyv8Y8jM5j9ZywQApfBOpinouIUjTmKNok6+Zr9SQ3e3
8vTJi8bOmQKBgQCF0222x1LMfoNtd/o5O9dZ1GKXhvpitPMpsT0tiiudMuYCcDw6
nAFqbiTBpymrQ4K2t2vYB50DYEYwTNN7K5ttvK4xX5gW9Y2Ehh6XHhsQzl3L7tjf
ZtHUKtFZlRmrEfuurYs9FUv2KMuxSIbzXnO3HYq/nuwmrZoiAJlUXoBqkQKBgCtR
mbbsb1XD19rD+ePveDAOV78Sf22uB0ZCZ0JBWsmWc6Tl+ce1C9Ti/ZLrTQ4red2K
bMg+hv2hBzw7kjw96UVG6s3AZiNzI3xo7X5oMF6yVWfIsFX+jLU1RUx+lzv1OfEw
oGtnGawhdqmuCEc4S9Bfb1F5NudomgJ9Ij89wsNBAoGAM16AxlHt10gLXbnBuJA+
BWTSjmilZ7ggW4uk9yI/jkF3mC+lJwy2rvlPK6J5RTZPiTdxh71MfZLfYawdVtaG
BilUFcX5jxlxZ7jM5iX0UqFCZEo0T61n1hy0UR9rkPb6GEnw1IUag4jfYDKbKqpI
9xGie1AEXZ3O7xSj7T0iMG0=
-----END PRIVATE KEY-----`;

const cert = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUBXj6+xk+UrSYdnNLeNmssqem6TwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDUyMTA0NDYwNFoXDTI3MDUy
MTA0NDYwNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAtR2FGhpp4rukxQ8nEnMBFL6aTKJDo+0FrvioZkX4/2tj
TaCSXdwkx+k2lRDlADUTITnajqKbGLp1q2TVp4gO09L98cn996TC4F+Bg2coF5Bm
ODVhnhOcmuLcqOZ1bWYaeOA0RpuVUEbJu7G1RoD8lUd0vYPLiubtikoTkBcX/Cbe
TfPL8tx+Mi4X1jhUlc5n6Tux0ezUe8Zkoyy6HAoTN2iZYkmms5XxxkHW+DxqK5Wg
n3ndjxDyTHsQJsFcaQ0u6u5aGqLma3mKVlONFQuVpkrU7fQeYvuMNftp+ZhM+g0G
dEs6MlUgk2xAqm+V4+5hSsJgZs0CWeu4LWrcIJMUCQIDAQABo1MwUTAdBgNVHQ4E
FgQUYeDXxZvdKB1u5qE7BLDTZMo72J0wHwYDVR0jBBgwFoAUYeDXxZvdKB1u5qE7
BLDTZMo72J0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAehcp
k1j7jcewEf+Wv4wrtnx2ilvJwVPUayd+9G+IddNDQzVFAgBsMqg3eZowhTyNtpgb
oN1TEct42X8yMPVdIV1lJtm7wqSLoxQPVEaCSeNdacSXFXEgDs+wZk4vdO6McEYq
lu0RLp1dffgjCkZGI+Z6Axj//2wIB5quioO9h2rEtuLz4eUgYtdDw2BbRhtDALCd
8RtvRioxJQ1wOcZ40qL1wCQCOsA5t0UuGJElRyQ6uxNTDr2/czWixHqzuj1asZ2w
xQkKnqvxehtEpqjDGO2PJJL5TEdzzSD5zqQdDS+SLXPmdRTKBXyw5el17qlpjnU4
cYd7ijcYzotguo4GEw==
-----END CERTIFICATE-----`;

const server = https.createServer({ key, cert }, (req, res) => {
  res.writeHead(200);
  res.end('hi');
});

server.listen(0, '127.0.0.1', () => {
  console.log('https-listen-ok');
  process.exit(0);
});

setTimeout(() => { console.log('https-listen-timeout'); process.exit(1); }, 5000);
