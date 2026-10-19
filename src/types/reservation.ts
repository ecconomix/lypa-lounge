export type Reservation = {
  id: string
  isTechnicalBlock?: boolean
  date: string
  startTime: string
  endTime: string
  description?: string
  nameOrApartment?: string
}
