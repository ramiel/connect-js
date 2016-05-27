/* eslint-env es6 */
/* global localStorage */

import bows from 'bows'
import TinyEmitter from 'tiny-emitter'
import * as jwks from './jwks'
import cryptors from './cryptors-with-fallbacks'
import domApis from './domApis'
import {checkAccessClaims, checkIdClaims} from './claimChecks'

let log = bows('Anvil')

let session = {}
let Anvil = {
  promise: {}
}

// All init functions below must be called!
/**
 * TODO: update comment.
 * Init function used for http requests.
 * Function is called with a config object as first parameter with
 * fields:
 *    method
 *    url
 *    crossDomain
 *    headers
 *
 *  It is expected to return a promise.
 */
function initHttpAccess (http) {
  if (http && typeof http === 'object' &&
    typeof http.request === 'function' &&
    typeof http.getData === 'function') {
    Anvil.apiHttp = http
  } else {
    throw new Error("Must pass in object with functions in fields: 'request', 'getData'.")
  }
}

Anvil.initHttpAccess = initHttpAccess

/**
 *  Init functions for location access.
 */
function initLocationAccess (loc) {
  if (loc && typeof loc === 'object' &&
    typeof loc.hash === 'function' &&
    typeof loc.path === 'function') {
    Anvil.locAccess = loc
    return
  }
  throw new Error("Must pass in object with functions in fields: 'hash', 'path'.")
}
Anvil.initLocationAccess = initLocationAccess

/**
 *  Init functions for DOM/window access.
 */
function initDOMAccess (da) {
  if (da && typeof da === 'object' &&
    typeof da.getWindow === 'function' &&
    typeof da.getDocument === 'function') {
    Anvil.domAccess = da
    return
  }
  throw new Error("Must pass in object with functions in fields: 'getWindow', 'getDocument'.")
}
Anvil.initDOMAccess = initDOMAccess

/**
 * Extend
 */

function extend () {
  var target = arguments[0]

  // iterate over arguments, excluding the first arg
  for (var i = 1; i < arguments.length; i++) {
    var source = arguments[i]

    // iterate through properties, copying to target
    for (var prop in source) {
      if (source[prop] !== undefined) { target[prop] = source[prop] }
    }
  }

  return target
}

/**
 * Support events, e.g. 'authenticated'
 *
 * The 'authenticated' event is emitted in response to a
 * local storage 'anvil.connect' event when the user is authenticated.
 *
 * This can be leveraged to react to an authentiation performed in
 * other windows or tabs.
 */
extend(Anvil, TinyEmitter.prototype)

/**
 * Provider configuration
 */
function configure (options) {
  var params
  Anvil.issuer = options.issuer
  jwks.setJWK(options.jwk)

  Anvil.params = params = {}
  params.response_type = options.response_type || 'id_token token'
  params.client_id = options.client_id
  params.redirect_uri = options.redirect_uri
  params.scope = [
    'openid',
    'profile'
  ].concat(options.scope).join(' ')
  Anvil.display = options.display || 'page'
}

Anvil.configure = configure

function init (providerOptions, apis) {
  if (providerOptions) {
    Anvil.configure(providerOptions)
  }

  Anvil.initHttpAccess(apis.http)

  const apiLocation = apis.location || domApis.location
  Anvil.initLocationAccess(apiLocation)

  const dom = apis.dom || domApis.dom
  Anvil.initDOMAccess(dom)

  // todo: perhaps this should be in its own method
  dom.getWindow().addEventListener('storage', Anvil.updateSession, true)
}

Anvil.init = init

Anvil.setNoWebCryptoFallbacks = cryptors.setNoWebCryptoFallbacks

/**
 * Do initializations which may require network calls.
 *
 * returns a promise.
 */

function prepareAuthorization () {
  return jwks.prepareKeys()
    .then(function (val) {
      log.debug('prepareAuthorization() succeeded.', val)
      return val
    }, function (err) {
      log.warn('prepareAuthorization() failed:', err.stack)
      throw err
    })
}

Anvil.promise.prepareAuthorization = prepareAuthorization

/**
 * Form Urlencode an object
 */

function toFormUrlEncoded (obj) {
  var pairs = []

  Object.keys(obj).forEach(function (key) {
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(obj[key]))
  })

  return pairs.join('&')
}

Anvil.toFormUrlEncoded = toFormUrlEncoded

/**
 * Parse Form Urlencoded data
 */

function parseFormUrlEncoded (str) {
  var obj = {}

  str.split('&').forEach(function (property) {
    var pair = property.split('=')
    var key = decodeURIComponent(pair[0])
    var val = decodeURIComponent(pair[1])

    obj[key] = val
  })

  return obj
}

Anvil.parseFormUrlEncoded = parseFormUrlEncoded

/**
 * Get URI Fragment
 */

function getUrlFragment (url) {
  return url.split('#').pop()
}

Anvil.getUrlFragment = getUrlFragment

/**
 * Configure the authorize popup window
 * Adapted from dropbox-js for ngDropbox
 */

function popup (popupWidth, popupHeight) {
  var x0, y0, width, height, popupLeft, popupTop

  var window = Anvil.domAccess.getWindow()
  var documentElement = Anvil.domAccess.getDocument().documentElement

  // Metrics for the current browser win.
  x0 = window.screenX || window.screenLeft
  y0 = window.screenY || window.screenTop
  width = window.outerWidth || documentElement.clientWidth
  height = window.outerHeight || documentElement.clientHeight

  // Computed popup window metrics.
  popupLeft = Math.round(x0) + (width - popupWidth) / 2
  popupTop = Math.round(y0) + (height - popupHeight) / 2.5
  if (popupLeft < x0) { popupLeft = x0 }
  if (popupTop < y0) { popupTop = y0 }

  return 'width=' + popupWidth + ',height=' + popupHeight + ',' +
  'left=' + popupLeft + ',top=' + popupTop + ',' +
  'dialog=yes,dependent=yes,scrollbars=yes,location=yes'
}

Anvil.popup = popup

function getCookieSecret () {
  const re = /\banvil\.connect=([^\s;]*)/
  let dom = Anvil.domAccess.getDocument()
  let cookie = dom.cookie
  try {
    return decodeURIComponent(cookie.match(re).pop())
  } catch (err) {
    log.debug('getCookieSecret(): failed, cookie=', cookie)
    throw err
  }
}

function setCookieSecret (secret) {
  log.debug('setCookieSecret():', secret)
  let dom = Anvil.domAccess.getDocument()
  var now = new Date()
  var time = now.getTime()
  var exp = time + (Anvil.session.expires_in || 3600) * 1000
  now.setTime(exp)
  var value = 'anvil.connect=' + encodeURIComponent(secret) +
    '; expires=' + now.toUTCString()
  dom.cookie = value

  try {
    let stored = getCookieSecret()
    if (stored !== secret) {
      log.debug('setCookieSecret(): read back cookie value differs', [stored, secret])
    }
  } catch (err) {
    log.debug('setCookieSecret(): failed to read back cookie')
  }
}

function clearCookieSecret () {
  log.debug('clearCookieSecret()')
  let dom = Anvil.domAccess.getDocument()
  dom.cookie = 'anvil.connect=; expires=Thu, 01 Jan 1970 00:00:01 GMT'
  try {
    let stored = getCookieSecret()
    log.debug('clearCookieSecret(): secret is now:', stored)
  } catch (err) {
    log.debug('clearCookieSecret(): secret could no longer be read back')
  }
}

/**
 * Session object
 */

Anvil.session = session

/**
 * Serialize session
 */

function serialize () {
  log.debug('serialize(): entering')
  let plaintext = JSON.stringify(Anvil.session)
  return cryptors.encryptor.encrypt(plaintext).then(({secret, encrypted}) => {
    setCookieSecret(secret)
    log.debug('serialize() stored secret in COOKIE anvil.connect')
    localStorage['anvil.connect.session.state'] = Anvil.sessionState
    log.debug('serialize() stored sessionState in local storage anvil.connect.session.state', Anvil.sessionState)
    localStorage['anvil.connect'] = encrypted
    log.debug('serialize() stored encrypted session data in local storage anvil.connect')
  }).catch(err => {
    log.debug('serialize failed with error:', err, err.stack)
    throw err
  })
}

Anvil.promise.serialize = serialize

/**
 * Deserialize session
 */
function deserialize () {
  const p = new Promise(function (resolve) {
    // Use the cookie value to decrypt the session in localStorage
    // Exceptions may occur if data is unexpected or there is no
    // session data yet.
    // An exception will reject the promise
    const secret = getCookieSecret()
    const encrypted = localStorage['anvil.connect']
    let parms = Object.assign({}, {
      secret: secret,
      encrypted: encrypted})
    resolve(parms)
  })

  return p.then(parms => {
    return cryptors.encryptor.decrypt(parms).then(plaintext => {
      // exceptions when parsing json causes the promise to be rejected
      return JSON.parse(plaintext)
    })
  }).then(parsed => {
    log.debug('Deserialized session data', parsed.userInfo)
    Anvil.session = session = parsed
    Anvil.sessionState = localStorage['anvil.connect.session.state']
    return session
  }).then(session => {
    Anvil.emit('authenticated', session) // todo: may need to emitted on failure also
    return session
  }).catch(e => {
    log.debug('Cannot deserialize session data', e)
    Anvil.session = session = {}
    Anvil.sessionState = localStorage['anvil.connect.session.state']
    Anvil.emit('not-authenticated', session)
    return session
  })
}

Anvil.promise.deserialize = deserialize

/**
 * Reset
 */

function reset () {
  log.debug('reset() called: clearing session')
  Anvil.session = session = {}
  clearCookieSecret()
  delete localStorage['anvil.connect']
}

Anvil.reset = reset

/**
 * Quick and dirty uri method with nonce (returns promise)
 */

function uri (endpoint, options) {
  return Anvil.promise.nonce().then(nonce => {
    return Anvil.issuer + '/' +
      (endpoint || 'authorize') + '?' +
      toFormUrlEncoded(extend({}, Anvil.params, options, {
        nonce: nonce
      }))
  })
}

Anvil.promise.uri = uri

/**
 * Create or verify a nonce
 */
function nonce (nonce) {
  if (nonce) {
    var lnonce = localStorage['nonce']
    if (!lnonce) {
      return Promise.resolve(false)
    }
    return Anvil.promise.sha256url(localStorage['nonce']).then(val => val === nonce)
  } else {
    localStorage['nonce'] = cryptors.encryptor.generateNonce()
    return Anvil.promise.sha256url(localStorage['nonce'])
  }
}

Anvil.promise.nonce = nonce

/**
 * Base64url encode a SHA256 hash of the input string
 *
 * @param str
 * @returns {promise}
 */
function sha256url (str) {
  return cryptors.encryptor.sha256url(str)
}

Anvil.promise.sha256url = sha256url

/**
 * Headers
 */

function headers (headers) {
  if (Anvil.session.access_token) {
    return extend(headers || {}, {
      'Authorization': 'Bearer ' + Anvil.session.access_token
    })
  } else {
    return headers
  }
}

Anvil.headers = headers

/**
 * Request
 */

function request (config) {
  config.headers = Anvil.headers(config.headers)
  config.crossDomain = true
  return Promise.resolve(Anvil.apiHttp.request(config)
    .then(function (val) {
      log.debug('request() succeeded.', config)
      return val
    }, function (err) {
      log.warn('request() failed:', config, err.stack)
      throw err
    }))
}

Anvil.promise.request = request

/**
 * UserInfo
 */

function userInfo () {
  return Anvil.promise.request({
    method: 'GET',
    url: Anvil.issuer + '/userinfo',
    crossDomain: true
  })
}

Anvil.promise.userInfo = userInfo

function find (arr, x) {
  for (let e of arr) {
    if (e === x) {
      return e
    }
  }
  return undefined
}

function validate_jwt (type, response) {
  const response_types = Anvil.params.response_type.trim().split(' ')
  const response_type = find(response_types, type)
  if (!response_type) {
    // token of this type is not required, so carry on.
    return Promise.resolve()
  }
  const tokenType = {
    'token': 'access',
    'id_token': 'id'
  }
  const token_type = `${tokenType[type]}_token`
  const token = response[token_type]
  if (!token) {
    return Promise.reject(new Error(`Expected ${token_type} not in response`))
  }
  const jwtvalidator = cryptors.jwtvalidator
  log.debug(`validate_jwt(): validateAndParseToken ${token_type}: ${token}`)
  const p = jwtvalidator.validateAndParseToken(jwks.jwk, token)
  return p.then(claims => {
    const f = (type === 'token') ? checkAccessClaims : checkIdClaims
    return f(claims, {
      issuer: Anvil.issuer,
      client_id: Anvil.params.client_id}
    )
  }).then(claims => {
    response[`${tokenType[type]}_claims`] = claims
  }).catch(err => {
    const msg = `validate_jwt(): ${token_type} not validated: ${err.message}`
    log.warn(msg, err.stack)
    throw new Error(msg)
  })
}

function verifyNonce (response) {
  if (response.id_claims) {
    log.debug('validateNonce(): checking id_claims.nonce')
    return Anvil.promise.nonce(response.id_claims.nonce)
      .then(nonceIsValid => {
        log.debug('callback(): nonceIsValid=', nonceIsValid)
        if (!nonceIsValid) {
          throw new Error('Invalid nonce.')
        }
      })
  }
  return Promise.resolve()
}

function verifyAtHash (response) {
  if (['id_token token'].indexOf(Anvil.params.response_type) !== -1) {
    log.debug('verifyAtHash(): checking at hash')
    return cryptors.encryptor.sha256sum(response.access_token)
      .then(atHash => {
        atHash = atHash.slice(0, atHash.length / 2)
        if (response.id_claims && atHash !== response.id_claims.at_hash) {
          throw new Error('Invalid at hash')
        }
      })
  }
  return Promise.resolve()
}

/**
 * Callback
 */

function callback (response) {
  log.debug('callback(): entering')
  if (response.error) {
    log.debug('callback(): with error=', response.error)
    // clear localStorage/cookie/etc
    Anvil.sessionState = response.session_state
    localStorage['anvil.connect.session.state'] = Anvil.sessionState
    Anvil.reset()
    return Promise.reject(response.error)
  } else {
    log.debug('callback(): on response=', response)
    // NEED TO REVIEW THIS CODE FOR SANITY
    // Check the conditions in which some of these verifications
    // are skipped.
    let apiHttp = Anvil.apiHttp

    const jwtvalidator = cryptors.jwtvalidator

    // Ensure:
    // missing tokens are not OK!
    // possible responses are enumerated in http://openid.net/specs/openid-connect-core-1_0.html#rfc.section.3
    // Authorization code flow seems questionable in browsers!

    // implicit:
    // a. response_type='id_token token' both MUST be returned.
    // b. response_type='id_token' no access token so no need and access token to get user info

    return Promise.resolve()
      // 0. ensure there is a jwk unless jwtvalidator does not need it.
      .then(() => {
        if (!jwtvalidator.noJWKrequired && !jwks.jwk) {
          throw new Error('You must call and fulfill Anvil.prepareAuthorization() before attempting to validate tokens')
        }
        log.debug('jwk=', jwks.jwk)
      })
      // 1. validate/parse access token
      .then(() => {
        // sets: response.access_claims if token is required and validation succeeds
        // otherwise is rejected.
        return validate_jwt('token', response)
      })
      // 2. validate/parse id token
      .then(() => {
        return validate_jwt('id_token', response) // sets response.id_claims if required.
      })
      // 3. verify nonce
      .then(() => {
        return verifyNonce(response)
      })
      // 4. Verify at_hash
      .then(() => {
        return verifyAtHash(response)
      })
      // If 1-4 check out establish session:
      .then(() => {
        Anvil.session = response
        log.debug('callback(): session=', Anvil.session)
        Anvil.sessionState = response.session_state
        log.debug('callback(): session state=', Anvil.sessionState)
      })
      // and retrieve user info
      .then(() => {
        if (response.access_token) {
          log.debug('callback(): retrieving user info')
          return Anvil.promise.userInfo().then(userInfoResponse => {
            // [Successful UserInfo Response](http://openid.net/specs/openid-connect-implicit-1_0.html#rfc.section.2.3.2)
            let userInfo = apiHttp.getData(userInfoResponse)
            // todo: If we get a bad userInfo we will not fail the session or should we?
            // Spec: 1. The sub claim MUST be returned
            // Spec: 2. The sub claim MUST be verified to exactly match the subClaim of the ID token.
            // Spec: 3. The Client MUST verify that the OP that responded was the intended OP through a TLS server certificate chec
            // Example response:
            // Object {sub: "c43f3fc8-048a-457a-9cff-0a25d6e4e6f0", family_name: "W", given_name: "P", updated_at: 1446218445857}
            // Now #3 should be done by any browser!
            // #1 and 2 is to be done here:
            if (!userInfo.sub) {
              log.error('Returned userInfo malformed')
              return
            } else if (response.id_claims && response.id_claims.sub !== userInfo.sub) {
              log.error('Returned userInfo is about a different user than id token')
              return
            } else {
              log.debug('callback(): setting user info', userInfo)
              Anvil.session.userInfo = userInfo
              return
            }
          })
          .catch(e => {
            log.warn('userInfo() retrieval failed with', e.message, e.stack)
          })
        } else {
          Promise.resolve()
        }
      })
      .then(() => {
        return Anvil.promise.serialize()
      })
      .then(() => {
        Anvil.emit('authenticated', Anvil.session)
        return Anvil.session
      })
      .catch(e => {
        log.debug('Exception during callback:', e.message, e.stack)
        throw e  // caller can ultimately handle this.
      })
  }
}

Anvil.promise.callback = callback

/**
 * Authorize
 */

function authorize () {
  // handle the auth response
  if (Anvil.locAccess.hash()) {
    console.log('authorize() with hash:', Anvil.locAccess.hash())
    return Anvil.promise.callback(parseFormUrlEncoded(Anvil.locAccess.hash()))

  // initiate the auth flow
  } else {
    Anvil.destination(Anvil.locAccess.path())

    var window = Anvil.domAccess.getWindow()
    if (Anvil.display === 'popup') {
      // open the signin page in a popup window
      // In a typical case the popup window will be redirected
      // to the configured callback page.

      // If this callback page is rendered in the popup it
      // should send the message:
      // `opener.postMessage(location.href, opener.location.origin)`.
      // This will then cause a login in this window (not the popup) as
      // implemented in the 'message' listener below.

      var popup

      let authMessageReceived = new Promise(function (resolve, reject) {
        let listener = function listener (event) {
          if (event.data !== '__ready__') {
            log.debug('authorize() popup: received message event data __ready__')
            var fragment = getUrlFragment(event.data)
            let response = parseFormUrlEncoded(fragment)
            log.debug('authorize() popup: checking callback with received response:', response)
            Anvil.promise.callback(response)
              .then(
              function (result) {
                log.debug('authorize() popup: callback promise resolved:', result)
                resolve(result)
              },
              function (fault) {
                log.debug('authorize() popup: callback promise rejected:', fault)
                reject(fault)
              }
            )
            window.removeEventListener('message', listener, false)
            if (popup) {
              log.debug('authorize() popup: message event closing popup')
              popup.close()
            }
          }
        }

        log.debug('authorize() popup: setting up message listener')
        window.addEventListener('message', listener, false)
      })
      // Some authentication methods will NOT cause a redirect ever!
      //
      // The passwordless login method sends the user a link in an email.
      // When the user presses this link then a new window openes with the
      // configured callback.
      // In Anvil case the callback page has no opener and is expected to
      // call Anvil.callback itself.
      // The listener below will react to the case where there is a
      // successful login and then close the popup.
      let authenticated = new Promise(function (resolve, reject) {
        log.debug('authorize() popup: setting up authenticated listener')
        Anvil.once('authenticated', function (session) {
          log.debug('authorize() popup: authenticated event received')
          resolve(session)
          if (popup) {
            log.debug('authorize() popup: authenticated event closing popup')
            popup.close()
          }
        })
      })
      return Anvil.promise.uri().then(uri => {
        log.debug('authorize() popup: opening popup at:', uri)
        popup = window.open(uri, 'anvil', Anvil.popup(700, 500))
        return Promise.race([authMessageReceived, authenticated])
      })
    } else {
      // navigate the current window to the provider
      return Anvil.promise.uri().then(uri => {
        window.location = uri
      })
    }
  }
}

Anvil.promise.authorize = authorize

/**
 * Signout
 */

function signout (path) {
  var win = Anvil.domAccess.getWindow()
  // parse the window location
  var url = Anvil.domAccess.getDocument().createElement('a')
  url.href = win.location.href
  url.pathname = path || '/'

  // set the destination
  Anvil.destination(path || false)

  // url to sign out of the auth server
  var signoutLocation = Anvil.issuer + '/signout?post_logout_redirect_uri=' +
    url.href + '&id_token_hint=' + Anvil.session.id_token

  // reset the session
  Anvil.reset()

  // "redirect"
  win.location = signoutLocation
}

Anvil.signout = signout

/**
 * Destination
 *
 * Getter/setter location.pathname
 *
 *    // Set the destination
 *    Anvil.destination(location.pathname)
 *
 *    // Get the destination
 *    Anvil.destination()
 *
 *    // Clear the destination
 *    Anvil.destination(false)
 */

function destination (path) {
  if (path === false) {
    path = localStorage['anvil.connect.destination']
    log.debug('destination(): deleting and returning:', path)
    delete localStorage['anvil.connect.destination']
    return path
  } else if (path) {
    log.debug('destination(): setting:', path)
    localStorage['anvil.connect.destination'] = path
  } else {
    var dest = localStorage['anvil.connect.destination']
    log.debug('destination(): retrieving:', dest)
    return dest
  }
}

Anvil.destination = destination

/**
 * Check Session
 *
 * This is for use by the RP iframe, as specified by
 * OpenID Connect Session Management 1.0 - draft 23
 *
 * http://openid.net/specs/openid-connect-session-1_0.html
 */

function checkSession (id) {
  // log.debug('checkSession()', id)
  var targetOrigin = Anvil.issuer
  var message = Anvil.params.client_id + ' ' + Anvil.sessionState
  var w = window.parent.document.getElementById(id).contentWindow
  // log.debug(`checkSession(): postMessage (${message}, ${targetOrigin} to win of element ${id})`, w)
  w.postMessage(message, targetOrigin)
}

Anvil.checkSession = checkSession

/**
 * Update Session
 */

function updateSession (event) {
  if (event.key === 'anvil.connect') {
    log.debug('updateSession(): anvil.connect: calling deserialize')
    Anvil.promise.deserialize()
    // happens now in deserialize
    // Anvil.emit('authenticated', Anvil.session)
  }
}

Anvil.updateSession = updateSession

/**
 * Is Authenticated
 */

function isAuthenticated () {
  return (Anvil.session.id_token)
}

Anvil.isAuthenticated = isAuthenticated

export default Anvil