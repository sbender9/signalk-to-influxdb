/*
 * Copyright 2018 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Influx = require('influx')
const debug = require('debug')('signalk-to-influxdb')
const { getSourceId } = require('@signalk/signalk-schema')

var lastUpdates = {}
var lastPositionStored = {}
var recordTrackEnabled = false

function addSource(update, tags) {
  if (update['$source']) {
    tags.source = update['$source']
  } else if (update['source']) {
    tags.source = getSourceId(update['source'])
  }
  return tags
}

module.exports = {
  deltaToPointsConverter: (
    selfContext,
    recordTrack,
    separateLatLon,
    shouldStore,
    resolution,
    storeOthers,
    honorDeltaTimestamp = true
  ) => {
    recordTrackEnabled = recordTrack
    return delta => {

      if (delta.context === 'vessels.self') {
        delta.context = selfContext
      }
      let points = []
      if (delta.updates && (storeOthers || delta.context === selfContext)) {
        delta.updates.forEach(update => {
          if (update.values) {
            let date = honorDeltaTimestamp ? new Date(update.timestamp) : new Date()
            let time = date.getTime()
            let tags = addSource(update, { context: delta.context })

            update.values.reduce((acc, pathValue) => {

              if (pathValue.path === 'navigation.position') {
                if (recordTrackEnabled && shouldStorePositionNow(delta, tags.source, time)) {
                  const point = {
                    measurement: pathValue.path,
                    tags: tags,
                    timestamp: date,
                    fields: {
                      jsonValue: JSON.stringify({
                        longitude: pathValue.value.longitude,
                        latitude: pathValue.value.latitude
                      }),
                    }
                  }
                  acc.push(point)
                  if (separateLatLon) {
                    const point = {
                      measurement: pathValue.path,
                      tags: tags,
                      timestamp: date,
                      fields: {
                        lon: pathValue.value.longitude,
                        lat: pathValue.value.latitude
                      }
                    }
                    acc.push(point)
                  }

                  if (!lastPositionStored[delta.context]) {
                    lastPositionStored[delta.context] = {}
                  }
                  lastPositionStored[delta.context][tags.source] = time
                }
              } else {
                const pathAndSource = `${pathValue.path}-${tags.source}`
                if (shouldStore(pathValue.path) &&
                  (pathValue.path == '' || shouldStoreNow(delta, pathAndSource, time, resolution))
                ) {
                  if (!lastUpdates[delta.context]) { lastUpdates[delta.context] = {} }
                  lastUpdates[delta.context][pathAndSource] = time

                  if (pathValue.path === 'navigation.attitude') {
                    storeAttitude(date, pathValue, tags, acc)
                  } else {
                    function addPoint(path, value) {
                      let valueKey = null

                      if (typeof value === 'number' &&
                        !isNaN(value)) {
                        valueKey = 'value'
                      } else if (typeof value === 'string') {
                        valueKey = 'stringValue'
                      } else if (typeof value === 'boolean') {
                        valueKey = 'boolValue'
                      } else {
                        valueKey = 'jsonValue'
                        value = JSON.stringify(value)
                      }

                      if (valueKey) {
                        const point = {
                          measurement: path,
                          timestamp: date,
                          tags: tags,
                          fields: {
                            [valueKey]: value
                          }
                        }
                        acc.push(point)
                      }
                    }

                    if (pathValue.path === '') {
                      Object.keys(pathValue.value).forEach(key => {
                        addPoint(key, pathValue.value[key])
                      })
                    } else {
                      addPoint(pathValue.path, pathValue.value)
                    }
                  }
                }
              }
              return acc
            }, points)
          }
        })
      }
      return points
    }
  },
  influxClientP: ({ protocol, host, port, database, username, password }) => {
    debug(`Attempting connection to ${host}${port} ${database} as username ${username ? username : 'n/a'} ${password ? '' : 'no password configured'}`)
    return new Promise((resolve, reject) => {
      const influxOptions = {
        host: host,
        port: port,
        protocol: protocol ? protocol : 'http',
        database: database
      }
      if (username) {
        influxOptions.username = username
        influxOptions.password = password
      }
      const client = new Influx.InfluxDB(influxOptions)

      client
        .getDatabaseNames()
        .then(names => {
          debug('Connected')
          if (names.includes(database)) {
            resolve(client)
          } else {
            client.createDatabase(database).then(result => {
              debug('Created InfluxDb database ' + database)
              resolve(client)
            })
          }
        })
        .catch(err => {
          reject(err)
        })
    })
  },
  pruneTimestamps(maxAge) {
    clearContextTimestamps(lastUpdates, maxAge)
    clearContextTimestamps(lastPositionStored, maxAge)
  },
  enableRecordTrack(enabled) {
    recordTrackEnabled = enabled
  }
}

function clearContextTimestamps(holder, maxAge) {
  Object.keys(holder).forEach(context => {
    const newestTimestamp = Object.keys(holder[context]).reduce((acc, key) => {
      return Math.max(  acc, holder[context][key])
    }, 0)
    if (Date.now() - maxAge > newestTimestamp) {
      delete holder[context]
    }
  })
}

function shouldStorePositionNow(delta, sourceId, time) {
  if (!lastPositionStored[delta.context]) {
    lastPositionStored[delta.context] = {}
  }
  return (!lastPositionStored[delta.context][sourceId]
      || time - lastPositionStored[delta.context][sourceId] > 1000)
}

function shouldStoreNow(delta, pathAndSource, time, resolution) {
  return (!lastUpdates[delta.context] || !lastUpdates[delta.context][pathAndSource] ||
      time - lastUpdates[delta.context][pathAndSource] > resolution)
}


function storeAttitude(date, pathValue, tags, acc) {
  ['pitch', 'roll', 'yaw'].forEach(key => {
    if (typeof pathValue.value[key] === 'number' &&
      !isNaN(pathValue.value[key])) {
      acc.push({
        measurement: `navigation.attitude.${key}`,
        timestamp: date,
        tags: tags,
        fields: {
          value: pathValue.value[key]
        }
      })
    }
  })
}
