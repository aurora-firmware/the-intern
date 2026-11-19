# Test certificates

A test-only certificate authority and a `localhost` certificate for the fake mail server
(`test/support/fake_mail_server.ts`). They are valid for 100 years and grant access to nothing: no real service
trusts the authority, and the keys are published in the repository on purpose.

| File                             | What it is                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ca.pem`, `ca.key`               | The test certificate authority. A test trusts it with `NODE_EXTRA_CA_CERTS=<path of ca.pem>` in the daemon child, or leaves it untrusted to see a certificate fail to verify. |
| `localhost.pem`, `localhost.key` | The server certificate for `localhost`, `127.0.0.1` and `::1`, signed by the authority.                                                                                       |

They were made with these commands, run in this folder:

```
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 36500 \
  -subj "/CN=The Intern test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl req -newkey rsa:2048 -nodes -keyout localhost.key -out localhost.csr -subj "/CN=localhost"

printf "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" > localhost.ext

openssl x509 -req -in localhost.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out localhost.pem \
  -days 36500 -extfile localhost.ext

rm localhost.csr localhost.ext ca.srl
```
