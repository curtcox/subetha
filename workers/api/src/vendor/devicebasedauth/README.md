# Vendored @devicebasedauth/verify

An unmodified copy of `packages/verify/src/*.js` (tests left out) from
[device-based-auth](https://github.com/curtcox/device-based-auth) at commit `30e69a5`, until the
package is published to npm (device-based-auth STATUS L14). It verifies devicebasedauth.org
credentials, DPoP proofs and status lists offline, and runs the OpenID Connect client used to link
accounts. `workers/api/src/dba.ts` is the only module that imports it.

The `.d.ts` files are ours: types for the parts subetha uses. The `.js` files must not be edited
here; fix them upstream and copy them again:

```sh
cp ../device-based-auth/packages/verify/src/{address-lists,credential,dns,events,grants,index,ip,issuer,jose,net,replay-do,rtt,site,status-list,verifier}.js workers/api/src/vendor/devicebasedauth/
(cd workers/api/src/vendor/devicebasedauth && shasum -a 256 *.js > SHA256SUMS)
```

then update the commit above. `shasum -a 256 -c SHA256SUMS` (in this directory) checks the copy.
