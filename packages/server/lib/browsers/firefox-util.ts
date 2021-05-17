import Bluebird from 'bluebird'
import Debug from 'debug'
import _ from 'lodash'
import Marionette from 'marionette-client'
import { Command } from 'marionette-client/lib/marionette/message.js'
import util from 'util'
import Foxdriver from '@benmalka/foxdriver'
import * as protocol from './protocol'

const errors = require('../errors')

const debug = Debug('cypress:server:browsers:firefox-util')

let forceGcCc: () => Promise<void>

let timings = {
  gc: [] as any[],
  cc: [] as any[],
  collections: [] as any[],
}

const getTabId = (tab) => {
  return _.get(tab, 'browsingContextID')
}

const isNotInternalFirefoxRequest = (cause) => {
  return (cause &&
    cause.loadingDocumentUri &&
    !cause.loadingDocumentUri.startsWith('moz-extension://')
  )
}

const getDelayMsForRetry = (i) => {
  if (i < 10) {
    return 100
  }

  if (i < 18) {
    return 500
  }

  if (i < 63) {
    return 1000
  }

  return
}

const getPrimaryTab = Bluebird.method((browser) => {
  const setPrimaryTab = () => {
    return browser.listTabs()
    .then((tabs) => {
      browser.tabs = tabs

      return browser.primaryTab = _.first(tabs)
    })
  }

  // on first connection
  if (!browser.primaryTab) {
    return setPrimaryTab()
  }

  // `listTabs` will set some internal state, including marking attached tabs
  // as detached. so use the raw `request` here:
  return browser.request('listTabs')
  .then(({ tabs }) => {
    const firstTab = _.first(tabs)

    // primaryTab has changed, get all tabs and rediscover first tab
    if (getTabId(browser.primaryTab.data) !== getTabId(firstTab)) {
      return setPrimaryTab()
    }

    return browser.primaryTab
  })
})

const attachToTabMemory = Bluebird.method((tab) => {
  // TODO: figure out why tab.memory is sometimes undefined
  if (!tab.memory) return

  if (tab.memory.isAttached) {
    return
  }

  return tab.memory.getState()
  .then((state) => {
    if (state === 'attached') {
      return
    }

    tab.memory.on('garbage-collection', ({ data }) => {
      data.num = timings.collections.length + 1
      timings.collections.push(data)
      debug('received garbage-collection event %o', data)
    })

    return tab.memory.attach()
  })
})

const logGcDetails = () => {
  const reducedTimings = {
    ...timings,
    collections: _.map(timings.collections, (event) => {
      return _
      .chain(event)
      .extend({
        duration: _.sumBy(event.collections, (collection: any) => {
          return collection.endTimestamp - collection.startTimestamp
        }),
        spread: _.chain(event.collections).thru((collection) => {
          const first = _.first(collection)
          const last = _.last(collection)

          return last.endTimestamp - first.startTimestamp
        }).value(),
      })
      .pick('num', 'nonincrementalReason', 'reason', 'gcCycleNumber', 'duration', 'spread')
      .value()
    }),
  }

  debug('forced GC timings %o', util.inspect(reducedTimings, {
    breakLength: Infinity,
    maxArrayLength: Infinity,
  }))

  debug('forced GC times %o', {
    gc: reducedTimings.gc.length,
    cc: reducedTimings.cc.length,
    collections: reducedTimings.collections.length,
  })

  debug('forced GC averages %o', {
    gc: _.chain(reducedTimings.gc).sum().divide(reducedTimings.gc.length).value(),
    cc: _.chain(reducedTimings.cc).sum().divide(reducedTimings.cc.length).value(),
    collections: _.chain(reducedTimings.collections).sumBy('duration').divide(reducedTimings.collections.length).value(),
    spread: _.chain(reducedTimings.collections).sumBy('spread').divide(reducedTimings.collections.length).value(),
  })

  debug('forced GC totals %o', {
    gc: _.sum(reducedTimings.gc),
    cc: _.sum(reducedTimings.cc),
    collections: _.sumBy(reducedTimings.collections, 'duration'),
    spread: _.sumBy(reducedTimings.collections, 'spread'),
  })

  // reset all the timings
  timings = {
    gc: [],
    cc: [],
    collections: [],
  }
}

export default {
  log () {
    logGcDetails()
  },

  collectGarbage () {
    return forceGcCc()
  },

  setup ({
    extensions,
    url,
    marionettePort,
    foxdriverPort,
  }) {
    return Bluebird.join(
      this.setupFoxdriver(foxdriverPort),
      this.setupMarionette(extensions, marionettePort),
      (_, navigateToUrlFn) => {
        return navigateToUrlFn(url)
      },
    )
    .return(null)
  },

  async setupFoxdriver (port) {
    await protocol._connectAsync({
      host: '127.0.0.1',
      port,
      getDelayMsForRetry,
    })

    const foxdriver = await Foxdriver.attach('127.0.0.1', port)

    const { browser } = foxdriver

    browser.on('error', (err) => {
      debug('received error from foxdriver connection, ignoring %o', err)
    })

    // use for debugging in devtools
    // global.browser = browser

    const { processDescriptor } = await browser.request('getProcess', { id: 0 })

    const actors = await browser.client.makeRequest({ to: processDescriptor.actor, type: 'getTarget' })

    browser.setActors(actors.process)

    const network = browser._get('console', 'network')

    network.on('request', (req) => {
      const { cause } = req

      // filter out all internal firefox network events...
      if (isNotInternalFirefoxRequest(cause)) {
        // debugger
        debug('got FF request %o', req)
      }
    })

    await network.startListeners()

    forceGcCc = () => {
      let gcDuration; let ccDuration

      const gc = (tab) => {
        return () => {
          // TODO: figure out why tab.memory is sometimes undefined
          if (!tab.memory) return

          const start = Date.now()

          return tab.memory.forceGarbageCollection()
          .then(() => {
            gcDuration = Date.now() - start
            timings.gc.push(gcDuration)
          })
        }
      }

      const cc = (tab) => {
        return () => {
          // TODO: figure out why tab.memory is sometimes undefined
          if (!tab.memory) return

          const start = Date.now()

          return tab.memory.forceCycleCollection()
          .then(() => {
            ccDuration = Date.now() - start
            timings.cc.push(ccDuration)
          })
        }
      }

      debug('forcing GC and CC...')

      return getPrimaryTab(browser)
      .then(async (tab) => {
        await attachToTabMemory(tab)
        await gc(tab)
        await cc(tab)

        debug('forced GC and CC completed %o', { ccDuration, gcDuration })
      })
      .tapCatch((err) => {
        debug('firefox RDP error while forcing GC and CC %o', err)
      })
    }
  },

  async setupMarionette (extensions, port) {
    await protocol._connectAsync({
      host: '127.0.0.1',
      port,
      getDelayMsForRetry,
    })

    const driver = new Marionette.Drivers.Promises({
      port,
      tries: 1, // marionette-client has its own retry logic which we want to avoid
    })

    const sendMarionette = (data) => {
      return driver.send(new Command(data))
    }

    debug('firefox: navigating page with webdriver')

    const onError = (from, reject?) => {
      if (!reject) {
        reject = (err) => {
          throw err
        }
      }

      return (err) => {
        debug('error in marionette %o', { from, err })
        reject(errors.get('FIREFOX_MARIONETTE_FAILURE', from, err))
      }
    }

    return driver.connect()
    .catch(onError('connection'))
    .then(() => {
      return new Bluebird((resolve, reject) => {
        const _onError = (from) => {
          return onError(from, reject)
        }

        const { tcp } = driver

        tcp.socket.on('error', _onError('Socket'))
        tcp.client.on('error', _onError('CommandStream'))

        return sendMarionette({
          name: 'WebDriver:NewSession',
          parameters: { acceptInsecureCerts: true },
        })
        .then(() => {
          return Bluebird.map(extensions, (path) => {
            return sendMarionette({
              name: 'Addon:Install',
              parameters: { path, temporary: true },
            })
          })
        })
        .then(() => {
          // resolve with the final function to
          // navigate to the URL
          const navigateToUrl = (url) => {
            return sendMarionette({
              name: 'WebDriver:Navigate',
              parameters: { url },
            })
          }

          return resolve(navigateToUrl)
        })
        .catch(_onError('commands'))
      })
    })
    // even though Marionette is not used past this point, we have to keep the session open
    // or else `acceptInsecureCerts` will cease to apply and SSL validation prompts will appear.
  },
}
